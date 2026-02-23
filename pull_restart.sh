echo "git pull";
echo "launchctl kickstart -k gui/501/com.unsaltedbutter.orchestrator"
echo "launchctl kickstart -k gui/501/com.unsaltedbutter.agent"

echo "======================================"
echo "               git pull"
echo "======================================"
git pull;
echo ="======================================"
echo "=============   $(git rev-parse --short HEAD)   ============="
echo "======================================="

launchctl kickstart -k gui/501/com.unsaltedbutter.orchestrator;
launchctl kickstart -k gui/501/com.unsaltedbutter.agent;
