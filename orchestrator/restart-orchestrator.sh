echo "launchctl kickstart -k gui/501/com.unsaltedbutter.orchestrator"
echo "tail -f ~/logs/orchestrator-stderr.log"

launchctl kickstart -k gui/501/com.unsaltedbutter.orchestrator

tail -f ~/logs/orchestrator-stderr.log
