echo "launchctl kickstart -k gui/501/com.unsaltedbutter.agent"
echo "tail -f ~/logs/agent-stderr.log"

launchctl kickstart -k gui/501/com.unsaltedbutter.agent


tail -f ~/logs/agent-stderr.log
