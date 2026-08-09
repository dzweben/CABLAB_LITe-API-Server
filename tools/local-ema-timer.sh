#!/bin/bash
# LITe EMA timer — the Mac's leg of the triple-redundant EMA trigger.
# Deployed copy (runtime): ~/Library/Application Support/cablab/
# Reference copy (versioned): STEMA_imports/tools/local-ema-timer.sh
#
# This machine holds NO sending credentials. It is purely an independent
# CLOCK: every 2 minutes during EMA hours it pings the Vercel sweeper,
# which owns the OpenPhone key and does carrier-history dedup before
# sending anything. Healthy pipeline → sweeper answers "nothing to do".
# GitHub Actions dead → this ping is what keeps prompts flowing.
#
# Runs outside ~/Desktop because macOS TCC blocks launchd agents from
# protected folders. Heartbeat goes through the GitHub contents API
# (gh CLI) instead of a local git checkout for the same reason.

set -u
BASE="$HOME/Library/Application Support/cablab"
GH=/opt/homebrew/bin/gh
REPO="dzweben/CABLAB_LITe-API-Server"
HB_PATH="app/private/data/local-timer-heartbeat.json"
LOG_PREFIX="$(TZ=America/New_York date '+%Y-%m-%d %H:%M:%S ET')"

SECRET=$(grep '^EMA_SWEEP_SECRET=' "$BASE/sweep.env" 2>/dev/null | cut -d= -f2-)
if [ -z "$SECRET" ]; then echo "$LOG_PREFIX no sweep.env secret — exiting"; exit 0; fi

HOUR=$(TZ=America/New_York date +%-H)
MIN=$(TZ=America/New_York date +%-M)
HHMM=$((HOUR * 60 + MIN))
TODAY=$(TZ=America/New_York date +%Y-%m-%d)

# Daily heartbeat via GitHub API: first run at/after 6:30 AM ET whose
# last committed heartbeat isn't from today. Single-file commit, no clone.
if [ "$HHMM" -ge 390 ] && [ -x "$GH" ]; then
  MARK="$BASE/.hb-$TODAY"
  if [ ! -f "$MARK" ]; then
    CUR=$("$GH" api "repos/$REPO/contents/$HB_PATH" 2>/dev/null)
    CUR_DAY=$(echo "$CUR" | /usr/bin/python3 -c "import json,sys,base64;d=json.load(sys.stdin);print(json.loads(base64.b64decode(d['content']))['at'][:10])" 2>/dev/null || echo "never")
    if [ "$CUR_DAY" != "$TODAY" ]; then
      SHA=$(echo "$CUR" | /usr/bin/python3 -c "import json,sys;print(json.load(sys.stdin).get('sha',''))" 2>/dev/null || echo "")
      NEW=$(/usr/bin/python3 -c "
import base64, json, datetime
body = json.dumps({'at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'leg': 'mac-launchd-timer'}, indent=2) + '\n'
print(base64.b64encode(body.encode()).decode())")
      if [ -n "$SHA" ]; then
        "$GH" api -X PUT "repos/$REPO/contents/$HB_PATH" -f message="Mac timer heartbeat [$TODAY]" -f content="$NEW" -f sha="$SHA" >/dev/null 2>&1
      else
        "$GH" api -X PUT "repos/$REPO/contents/$HB_PATH" -f message="Mac timer heartbeat [$TODAY]" -f content="$NEW" >/dev/null 2>&1
      fi
      if [ $? -eq 0 ]; then echo "$LOG_PREFIX heartbeat committed for $TODAY"; rm -f "$BASE"/.hb-2*; touch "$MARK";
      else echo "$LOG_PREFIX heartbeat API push failed (will retry next run)"; fi
    else
      touch "$MARK"; rm -f $(ls "$BASE"/.hb-2* 2>/dev/null | grep -v "$TODAY") 2>/dev/null
    fi
  fi
fi

# EMA hours gate: 6:40 AM – 9:30 PM ET covers every segment plus grace.
if [ "$HHMM" -lt 400 ] || [ "$HHMM" -gt 1290 ]; then exit 0; fi

RESP=$(/usr/bin/curl -fsS -m 50 -H "x-sweep-secret: $SECRET" \
  "https://cablab-lite.vercel.app/api/ema-sweep?trigger=mac-timer" 2>&1)
CODE=$?
if [ $CODE -eq 0 ]; then
  SENT=$(echo "$RESP" | /usr/bin/python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d.get('sent',[])))" 2>/dev/null || echo "?")
  if [ "$SENT" != "0" ] && [ "$SENT" != "?" ]; then
    echo "$LOG_PREFIX sweeper SENT $SENT late prompt(s): $RESP"
  fi
  if [ "$MIN" -lt 2 ]; then echo "$LOG_PREFIX ping ok ($RESP)"; fi
else
  # 22/403 is expected until the rotated secret reaches Vercel (next deploy).
  echo "$LOG_PREFIX ping failed (curl exit $CODE): ${RESP:0:200}"
fi
exit 0
