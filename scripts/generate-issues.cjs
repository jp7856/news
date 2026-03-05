const fs = require("fs");
const path = require("path");

const issues = require("../data/issues.json");

const outDir = path.join(__dirname, "../data/issues");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

issues.forEach((i) => {
  const file = path.join(outDir, `${i.issue}.json`);

  if (fs.existsSync(file)) return;

  const data = {
    articles: [
      {
        title: "Sample Article",
        summary: "기사 요약",
        level: "elementary",
        file: "article.html"
      }
    ]
  };

  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log("created", file);
});

console.log("done");