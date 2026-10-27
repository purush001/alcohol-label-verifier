// Minimal static server for local use: npm start  ->  http://localhost:8080
const http = require("http"), fs = require("fs"), path = require("path");
const dir = path.join(__dirname, "..", "public");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".jpg": "image/jpeg", ".csv": "text/csv", ".wasm": "application/wasm" };
const port = process.env.PORT || 8080;
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(dir, path.normalize(p));
  if (!file.startsWith(dir)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(port, () => console.log(`Label verifier running at http://localhost:${port}`));
