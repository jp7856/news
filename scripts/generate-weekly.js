import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const ISSUES_DIR = path.join(DATA_DIR, "issues");
const ISSUES_INDEX = path.join(DATA_DIR, "issues.json");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function formatDateKR(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${da}`;
}

function lastMondayKST(now = new Date()) {
  // GitHub Actions는 UTC일 수 있어. 날짜 계산은 단순히 “가장 최근 월요일”로.
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun..1=Mon
  const diff = (day + 6) % 7; // 월요일이면 0, 화요일이면 1...
  d.setDate(d.getDate() - diff);
  d.setHours(0,0,0,0);
  return d;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "jp-times-bot" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}

function pickHotTopics(items, topN = 5) {
  // 매우 단순한 “이슈화” 점수: 제목 정규화 후 빈도
  const norm = (s) =>
    s
      .replace(/\[[^\]]+\]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const map = new Map();
  for (const it of items) {
    const key = norm(it.title || "");
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }

  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, cnt]) => ({ topic: key, score: cnt }));
}

async function generateArticlesPayload({ topics, issueNo, dateStr }) {
  // ✅ 여기서 “현재 너의 기사 형식”에 맞춰 ARTICLES 구조를 만들면 됨
  // 일단 기본 스켈레톤: seq 1..5만 생성(초등 5개 기준)
  const articles = {};
  topics.forEach((t, idx) => {
    const seq = idx + 1;
    articles[seq] = {
      title: {
        elementary: `[핫이슈] ${t.topic}`,
        middle: `[핫이슈] ${t.topic}`,
        high: `[핫이슈] ${t.topic}`
      },
      image: {
        elementary: "",
        middle: "",
        high: ""
      },
      // 아래 필드는 article.html이 무엇을 쓰는지에 맞춰 조정 필요
      body: {
        elementary: `이번 주 가장 많이 다뤄진 이슈는 "${t.topic}" 입니다. (점수: ${t.score})`,
        middle: `이번 주 핵심 이슈: "${t.topic}" — 여러 매체에서 반복적으로 언급되었습니다. (점수: ${t.score})`,
        high: `"${t.topic}" 관련 보도가 집중되었고, 쟁점과 파급효과가 논의되었습니다. (점수: ${t.score})`
      },
      meta: {
        issue: issueNo,
        date: dateStr
      }
    };
  });

  return {
    issue: issueNo,
    date: dateStr,
    ARTICLES: articles
  };
}

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(ISSUES_DIR);

  // 1) 다음 호수 번호 계산
  let issues = [];
  if (fs.existsSync(ISSUES_INDEX)) {
    issues = JSON.parse(fs.readFileSync(ISSUES_INDEX, "utf-8"));
  }

  const latest = issues[0]?.issue || 1061;
  const nextIssue = latest + 1;

  // 2) 이번 호 날짜(월요일)
  const mon = lastMondayKST(new Date());
  const dateStr = formatDateKR(mon);

  // 3) RSS 수집(원하는 소스로 바꿔도 됨)
  const feeds = [
    // 예시: 구글뉴스 RSS(키워드 기반) — 필요시 바꿔
    "https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko"
  ];

  const parser = new XMLParser({ ignoreAttributes: false });
  const items = [];

  for (const url of feeds) {
    try {
      const xml = await fetchText(url);
      const json = parser.parse(xml);
      const channel = json?.rss?.channel;
      const feedItems = channel?.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
      feedItems.forEach((it) => {
        items.push({
          title: it.title,
          link: it.link,
          pubDate: it.pubDate
        });
      });
    } catch (e) {
      console.error("Feed error:", url, e.message);
    }
  }

  const topics = pickHotTopics(items, 5);
  const payload = await generateArticlesPayload({ topics, issueNo: nextIssue, dateStr });

  // 4) 파일 저장
  const issueFile = path.join(ISSUES_DIR, `${nextIssue}.json`);
  fs.writeFileSync(issueFile, JSON.stringify(payload, null, 2), "utf-8");

  // 5) issues.json 갱신(최신이 위로)
  const newEntry = { issue: nextIssue, date: dateStr };
  const newIssues = [newEntry, ...issues.filter((x) => x.issue !== nextIssue)];
  fs.writeFileSync(ISSUES_INDEX, JSON.stringify(newIssues, null, 2), "utf-8");

  console.log(`Generated issue ${nextIssue} (${dateStr}) -> ${issueFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});