from pathlib import Path

path = Path("tests/rendered-html.test.mjs")
text = path.read_text(encoding="utf-8")
old = '  assert.doesNotMatch(html, /LOCAL RENDER CONSOLE|LOCAL VIDEO LAB|8787|local bridge/i);'
new = '  assert.doesNotMatch(html, /LOCAL RENDER CONSOLE|LOCAL VIDEO LAB|https?:\\/\\/(?:127\\.0\\.0\\.1|localhost):8787\\b|local bridge/i);'
if text.count(old) != 1:
    raise SystemExit("Expected one legacy rendered-html assertion to refine.")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Rendered HTML legacy endpoint assertion refined.")
