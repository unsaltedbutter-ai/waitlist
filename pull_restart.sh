echo "git pull";
echo "launchctl kickstart -k gui/501/com.unsaltedbutter.orchestrator"
echo "launchctl kickstart -k gui/501/com.unsaltedbutter.agent"
echo ="======================================"
echo "=============   $(git rev-parse --short HEAD)   ============="
echo "======================================="

git pull;
launchctl kickstart -k gui/501/com.unsaltedbutter.orchestrator;
launchctl kickstart -k gui/501/com.unsaltedbutter.agent;
