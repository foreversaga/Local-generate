export function writeSolH3SseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

export function writeSolH3SseEvent(res, event, { eventName = "job", id } = {}) {
  if (id !== undefined && id !== null) res.write(`id: ${String(id)}\n`);
  if (eventName) res.write(`event: ${eventName}\n`);
  const payload = JSON.stringify(event);
  for (const line of payload.split(/\r?\n/u)) res.write(`data: ${line}\n`);
  res.write("\n");
}

export function writeSolH3SseComment(res, comment = "keepalive") {
  res.write(`: ${String(comment).replace(/[\r\n]+/gu, " ")}\n\n`);
}
