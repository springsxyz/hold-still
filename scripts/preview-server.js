// Local-only static server for eyeballing popup/popup.html with its stylesheet
// applied. Not part of the extension and not included by scripts/package.ps1.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = 5177;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json"
};

http
  .createServer((request, response) => {
    const requestPath = decodeURIComponent(request.url.split("?")[0]);
    const target = path.join(root, requestPath === "/" ? "popup/popup.html" : requestPath);

    if (!target.startsWith(root)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(target, (error, body) => {
      if (error) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentTypes[path.extname(target)] || "application/octet-stream"
      });
      response.end(body);
    });
  })
  .listen(port, () => {
    console.log("Popup preview on http://localhost:" + port);
  });
