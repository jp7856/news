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
  // 러프하게 "가장 최근 월요일" 날짜만 계산(시간은 00:00)
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun..1=Mon
  const diff = (day + 6) % 7; // Mon=0, Tue=1...
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "jp-times-bot" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return await res.text();
}

function pickHotTopics(items, topN = 12) {
  const norm = (s) =>
    (s || "")
      .replace(/\[[^\]]+\]/g, "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const map = new Map();
  for (const it of items) {
    const key = norm(it.title);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }

  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, cnt]) => ({ topic: key, score: cnt }));
}

function buildPayload({ topics, issueNo, dateStr }) {
  // ✅ 기사 1..12 생성 (list.html에서 level별로 5/8/12개만 보여줌)
  const articles = {};
  topics.forEach((t, idx) => {
    const seq = idx + 1;
    const headline = t.topic;

    articles[String(seq)] = {
      title: {
        elementary: `[핫이슈] ${headline}`,
        middle: `[핫이슈] ${headline}`,
        high: `[핫이슈] ${headline}`
      },
      image: { elementary: "", middle: "", high: "" },
      body: {
        elementary: `이번 주 가장 많이 다뤄진 이슈는 "${headline}" 입니다. (점수: ${t.score})`,
        middle: `이번 주 핵심 이슈: "${headline}" — 여러 매체에서 반복적으로 언급되었습니다. (점수: ${t.score})`,
        high: `"${headline}" 관련 보도가 집중되었고, 쟁점과 파급효과가 논의되었습니다. (점수: ${t.score})`
      },
      meta: { issue: issueNo, date: dateStr }
    };
  });

  return { issue: issueNo, date: dateStr, ARTICLES: articles };
}

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(ISSUES_DIR);

  // 1) 다음 호수 번호 계산 (issues.json은 최신이 위)
  let issues = [];
  if (fs.existsSync(ISSUES_INDEX)) {
    issues = JSON.parse(fs.readFileSync(ISSUES_INDEX, "utf-8"));
  }

  const latest = issues[0]?.issue || 1061;
  const nextIssue = latest + 1;

  // 2) 이번 호 날짜(월요일)
  const mon = lastMondayKST(new Date());
  const dateStr = formatDateKR(mon);

  // 3) RSS 수집
  const feeds = [
    "https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko"
  ];

  const parser = new XMLParser({ ignoreAttributes: false });
  const items = [];

  for (const url of feeds) {
    try {
      const xml = await fetchText(url);
      const json = parser.parse(xml);
      const channel = json?.rss?.channel;
      const feedItems = channel?.item
        ? Array.isArray(channel.item) ? channel.item : [channel.item]
        : [];

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

  // 4) 토픽 뽑기 + fallback 채우기
  const fallback = [
    "경제", "정치", "사회", "국제", "과학", "기술",
    "교육", "문화", "연예", "스포츠", "환경", "건강"
  ];

  let topics = pickHotTopics(items, 12);
  while (topics.length < 12) {
    topics.push({ topic: fallback[topics.length], score: 0 });
  }
  topics = topics.slice(0, 12);

  // 5) payload 생성
  const payload = buildPayload({ topics, issueNo: nextIssue, dateStr });

  // 6) 파일 저장
  const issueFile = path.join(ISSUES_DIR, `${nextIssue}.json`);
  fs.writeFileSync(issueFile, JSON.stringify(payload, null, 2), "utf-8");

  // 7) issues.json 갱신(최신이 위로)
  const newEntry = { issue: nextIssue, date: dateStr };
  const newIssues = [newEntry, ...issues.filter((x) => x.issue !== nextIssue)];
  fs.writeFileSync(ISSUES_INDEX, JSON.stringify(newIssues, null, 2), "utf-8");

  console.log(`Generated issue ${nextIssue} (${dateStr}) -> ${issueFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});