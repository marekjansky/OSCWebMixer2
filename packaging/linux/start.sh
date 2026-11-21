#!/bin/sh
# Starts OSC Web Mixer and restarts it if it stops.
cd "$(dirname "$0")" || exit 1
while true; do
	./OSCWebMixer2
	echo "$(date) OSCWebMixer2 exited with code $?, restarting in 3 s" >> restarts.log
	sleep 3
done
