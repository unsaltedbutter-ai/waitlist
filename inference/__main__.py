"""Allow running the inference server with: python -m inference"""

import uvicorn

from inference.config import Config

if __name__ == "__main__":
    cfg = Config.load()
    uvicorn.run(
        "inference.server:app",
        host=cfg.host,
        port=cfg.port,
        log_level=cfg.log_level.lower(),
    )
