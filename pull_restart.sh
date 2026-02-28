echo "git pull";
echo "launchctl kickstart -k gui/501/com.unsaltedbutter.orchestrator"
echo "launchctl kickstart -k gui/501/com.unsaltedbutter.agent"

echo "======================================"
echo "               git pull"
echo "======================================"
git pull;
cd ../unsaltedbutter-prompts;
git pull;
echo ="======================================"
echo "========   Prompts: $(git rev-parse --short HEAD)   ========="
echo "======================================="

cd ../unsaltedbutter;

echo ="======================================"
echo "==========   Apps: $(git rev-parse --short HEAD)   =========="
echo "======================================="

launchctl kickstart -k gui/501/com.unsaltedbutter.orchestrator;
launchctl kickstart -k gui/501/com.unsaltedbutter.agent;
