#!/usr/bin/env python3
"""Playbook CLI: run cancel/resume flows via VLMExecutor.

Usage:
    python -m agent.bin.playbook run --service netflix --action cancel
"""

import argparse
import asyncio
import getpass
import os
import re
import sys
import threading
import time

# The agent/ directory is a namespace package. Ensure the project root is on
# sys.path and agent/ itself is removed so that `from agent.config import ...`
# resolves to the agent directory (namespace package), not a file.
_PROJECT_ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
_AGENT_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
sys.path[:] = [p for p in sys.path if os.path.normpath(p) != _AGENT_DIR]
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


SERVICES = ['netflix', 'hulu', 'disney', 'appletv', 'paramount', 'peacock', 'max']


def _slugify_plan(plan: str) -> str:
    """Turn a plan name into a filename-safe variant slug.

    'Standard with ads' -> 'standard_with_ads'
    'Premium' -> 'premium'
    """
    slug = plan.lower().strip()
    slug = re.sub(r'[^a-z0-9]+', '_', slug)
    return slug.strip('_')


# ------------------------------------------------------------------
# run command
# ------------------------------------------------------------------

def cmd_run(args):
    from agent.profile import PROFILES, NORMAL
    from agent.recording.vlm_client import VLMClient
    from agent.vlm_executor import VLMExecutor

    # Validate VLM settings
    missing = []
    if not args.vlm_url:
        missing.append('--vlm-url or VLM_URL')
    if not args.vlm_key:
        missing.append('--vlm-key or VLM_KEY')
    if not args.vlm_model:
        missing.append('--vlm-model or VLM_MODEL')
    if missing:
        print(f'ERROR: Missing VLM config: {", ".join(missing)}')
        print('  Set via CLI flags or environment variables.')
        sys.exit(1)

    # Collect credentials
    email = input('Email: ').strip()
    password = getpass.getpass('Password: ')
    credentials = {'email': email, 'pass': password}
    if args.cvv:
        cvv = getpass.getpass('CVV: ')
        credentials['cvv'] = cvv

    # Plan tier for resume
    plan_tier = ''
    if args.plan:
        plan_tier = _slugify_plan(args.plan)

    if args.action == 'resume' and not args.plan:
        print('WARNING: --plan not set for resume. The executor will pick whatever plan is shown.')

    # Set up VLM client
    vlm = VLMClient(
        base_url=args.vlm_url,
        api_key=args.vlm_key,
        model=args.vlm_model,
    )

    # Set up async event loop for OTP callback
    loop = asyncio.new_event_loop()
    threading.Thread(target=loop.run_forever, daemon=True).start()

    async def otp_callback(job_id, service, prompt):
        code = await loop.run_in_executor(
            None, lambda: input('\nEnter verification code (empty to skip): ').strip(),
        )
        return code or None

    # Build profile
    profile = PROFILES.get(args.profile) or NORMAL

    # Build executor
    executor = VLMExecutor(
        vlm=vlm,
        profile=profile,
        otp_callback=otp_callback,
        loop=loop,
        settle_delay=args.settle_delay,
        max_steps=args.max_steps,
    )

    print()
    print(f'Service:  {args.service}')
    print(f'Action:   {args.action}')
    print(f'Profile:  {args.profile or "normal"}')
    if plan_tier:
        print(f'Plan:     {args.plan} ({plan_tier})')
    print(f'VLM:      {args.vlm_model}')
    print()
    print('Starting...')
    print()

    try:
        result = executor.run(
            service=args.service,
            action=args.action,
            credentials=credentials,
            job_id=f'cli-{int(time.time())}',
            plan_tier=plan_tier,
        )
    except KeyboardInterrupt:
        print('\nAborted.')
        return
    finally:
        # Zero credentials
        for key in list(credentials.keys()):
            credentials[key] = '\x00' * len(credentials[key])
        credentials.clear()
        vlm.close()
        loop.call_soon_threadsafe(loop.stop)

    # Print results
    print()
    print(f'Result:   {"SUCCESS" if result.success else "FAILED"}')
    print(f'Duration: {result.duration_seconds:.1f}s')
    print(f'Steps:    {result.step_count}')
    print(f'VLM calls:{result.inference_count}')
    if result.billing_date:
        print(f'Billing:  {result.billing_date}')
    if result.error_message:
        print(f'Error:    {result.error_message}')


# ------------------------------------------------------------------
# main
# ------------------------------------------------------------------

def main():
    # Load env files (same pattern as agent/server.py)
    from pathlib import Path
    try:
        from dotenv import load_dotenv
        ub_dir = Path.home() / '.unsaltedbutter'
        shared_env = ub_dir / 'shared.env'
        component_env = ub_dir / 'agent.env'
        if shared_env.exists():
            load_dotenv(str(shared_env))
        if component_env.exists():
            load_dotenv(str(component_env), override=True)
    except ImportError:
        pass  # dotenv not installed, rely on shell env

    parser = argparse.ArgumentParser(description='Run cancel/resume flows via VLMExecutor')
    sub = parser.add_subparsers(dest='command')

    p_run = sub.add_parser('run', help='Execute a cancel or resume flow')
    p_run.add_argument('--service', required=True, choices=SERVICES,
                       help='Service name')
    p_run.add_argument('--action', required=True, choices=['cancel', 'resume'],
                       help='Flow type')
    p_run.add_argument('--plan', default='',
                       help='Plan tier for resume (e.g. "Premium", "Standard with ads")')
    p_run.add_argument('--cvv', action='store_true',
                       help='Prompt for CVV (services that require it on resume)')
    p_run.add_argument('--vlm-url', dest='vlm_url',
                       default=os.environ.get('VLM_URL', ''),
                       help='VLM API base URL (env: VLM_URL)')
    p_run.add_argument('--vlm-key', dest='vlm_key',
                       default=os.environ.get('VLM_KEY', ''),
                       help='VLM API key (env: VLM_KEY)')
    p_run.add_argument('--vlm-model', dest='vlm_model',
                       default=os.environ.get('VLM_MODEL', ''),
                       help='VLM model name (env: VLM_MODEL)')
    p_run.add_argument('--max-steps', type=int, default=60, dest='max_steps',
                       help='Maximum VLM analysis steps (default: 60)')
    p_run.add_argument('--settle-delay', type=float, default=2.5, dest='settle_delay',
                       help='Seconds to wait after each action (default: 2.5)')
    p_run.add_argument('--profile', choices=['fast', 'normal', 'cautious'], default=None,
                       help='Human behavior preset (default: normal)')

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(1)

    dispatch = {
        'run': cmd_run,
    }
    dispatch[args.command](args)


if __name__ == '__main__':
    main()
