#!/usr/bin/env bash
# End-to-end check against the RUNNING docker compose stack (docker compose up --build -d).
# Verifies: ingestion, idempotency, delivery, failure+retry, recovery, replay-able history.
set -euo pipefail
API=${API:-http://localhost:3000}; RCV=${RCV:-http://localhost:4000}
KEY=${KEY:-rx_demo_local_key_0123456789abcdef}
H=(-H "Authorization: Bearer $KEY" -H "Content-Type: application/json")
j() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
step() { echo; echo "--> $*"; }

step "health";  curl -fsS "$API/health"; echo
EP=$(curl -fsS "${H[@]}" "$API/api/v1/endpoints" | j "d['data'][0]['id']")
echo "endpoint: $EP"
curl -fsS -X POST "$RCV/control/reset" >/dev/null

step "send event with idempotency key (twice) - expect 202 then 200 and the same event id"
BODY="{\"eventType\":\"order.created\",\"endpointId\":\"$EP\",\"payload\":{\"orderId\":\"smoke\"},\"idempotencyKey\":\"smoke-$(date +%s)\"}"
R1=$(curl -sS -o /tmp/r1 -w "%{http_code}" -X POST "${H[@]}" -d "$BODY" "$API/api/v1/events")
R2=$(curl -sS -o /tmp/r2 -w "%{http_code}" -X POST "${H[@]}" -d "$BODY" "$API/api/v1/events")
echo "first=$R1 second=$R2"; [ "$R1" = 202 ] && [ "$R2" = 200 ]
ID1=$(j "d['event']['id']" </tmp/r1); ID2=$(j "d['event']['id']" </tmp/r2); [ "$ID1" = "$ID2" ] && echo "same event id: OK"
DEL=$(j "d['delivery']['id']" </tmp/r1)

wait_status() { for _ in $(seq 1 60); do S=$(curl -fsS "${H[@]}" "$API/api/v1/deliveries/$1" | j "d['status']"); [ "$S" = "$2" ] && return 0; sleep 1; done; return 1; }
step "healthy receiver: expect SUCCESS"; wait_status "$DEL" SUCCESS && echo "SUCCESS: OK"

step "make receiver fail for 12 s, send an event, expect RETRY_WAITING, then SUCCESS after recovery"
curl -fsS -X POST -H "Content-Type: application/json" -d '{"seconds":12}' "$RCV/control/fail" >/dev/null
BODY2="{\"eventType\":\"order.created\",\"endpointId\":\"$EP\",\"payload\":{\"orderId\":\"smoke-retry\"}}"
DEL2=$(curl -fsS -X POST "${H[@]}" -d "$BODY2" "$API/api/v1/events" | j "d['delivery']['id']")
wait_status "$DEL2" RETRY_WAITING && echo "RETRY_WAITING: OK"
wait_status "$DEL2" SUCCESS && echo "recovered -> SUCCESS: OK"
curl -fsS "${H[@]}" "$API/api/v1/deliveries/$DEL2" | j "[(a['attemptNumber'], a['statusCode'] or a['error']) for a in d['attempts']]"

step "bad API key -> 401"; [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer nope' "$API/api/v1/events")" = 401 ] && echo "OK"
step "metrics"; curl -fsS "$API/metrics" | grep -E '^relayx_(events_received_total|queue_depth)' | head
echo; echo "SMOKE TEST PASSED"
