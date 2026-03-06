// scripts/generate-weekly.js
// - RSS에서 제목/요약/링크를 가져오고
// - 이미지: RSS media/enclosure → 없으면 원문 HTML에서 og:image
// - 요약: RSS description/content → 없으면 og:description
// - 결과: data/issues/<newIssue>.json + data/issues.json 갱신
//
// Node 18+ (GitHub Actions/Cloudflare Pages 빌드 환경 대부분 OK)

import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const ISSUES_DIR = path.join(DATA_DIR, "issues");
const INDEX_FILE = path.join(DATA_DIR, "issues.json");

// 프로젝트에 이미 있는 로컬 이미지(최후 fallback)
const LOCAL_FALLBACK_IMAGES = [
  "images/chocolate.jpg",
  "images/dict.jpg",
  "images/planet.jpg",
  "images/tteokguk.jpg",
  "images/default-elementary.jpg",
  "images/default-middle.jpg",
  "images/default-high.jpg",
].filter((p) => fs.existsSync(path.join(ROOT, p)));

// ✅ 여기에 원하는 RSS를 추가/교체하면 됨
// (RSS는 사이트마다 이미지 포함 여부가 다름. 그래서 og:image fallback을 둠)
const FEEDS = [
  // 예시(원하는 걸로 바꾸세요)
  // "https://www.yonhapnewstv.co.kr/browse/feed/",
  // "https://rss.donga.com/total.xml",
  // "https://www.hani.co.kr/rss/",
  // "https://www.khan.co.kr/rss/rssdata/total_news.xml",
  // "https://feeds.bbci.co.uk/news/world/rss.xml",
];

const DEFAULT_FEEDS_MESSAGE =
  "FEEDS가 비어있습니다. scripts/generate-weekly.js의 FEEDS 배열에 RSS URL을 추가하세요.";

const TARGET = { elementary: 380, middle: 900, high: 1600 };
const DEFAULT_ARTICLE_COUNT = 12;

// -------- utilities --------
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
}
function formatDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}
function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function truncate(s, n) {
  const t = String(s || "").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}
function dedupeKeepOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
function safeUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}
function absolutizeUrl(base, maybeRelative) {
  try {
    const u = new URL(maybeRelative, base);
    return safeUrl(u.toString());
  } catch {
    return "";
  }
}

function getNextIssueNumber() {
  const idx = readJson(INDEX_FILE, []);
  const max = idx.reduce((acc, it) => Math.max(acc, Number(it.issue) || 0), 0);
  return max ? max + 1 : 1061;
}
function upsertIndex(issueNo, dateStr) {
  const idx = readJson(INDEX_FILE, []);
  const next = [{ issue: Number(issueNo), date: dateStr }, ...idx.filter((x) => Number(x.issue) !== Number(issueNo))];
  writeJson(INDEX_FILE, next);
}

function fallbackImageByIndex(i) {
  if (!LOCAL_FALLBACK_IMAGES.length) return "";
  return LOCAL_FALLBACK_IMAGES[i % LOCAL_FALLBACK_IMAGES.length];
}

// ---- HTTP fetch with timeout ----
async function fetchText(url, ms = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "jp-times-bot/1.0 (+https://news-evh.pages.dev)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!r.ok) return "";
    return await r.text();
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

function extractOg(html) {
  // 아주 단순하지만 og:*는 대부분 이 정도로 충분
  const getMeta = (propNames) => {
    for (const prop of propNames) {
      const re = new RegExp(
        `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["'][^>]*>`,
        "i"
      );
      const m = html.match(re);
      if (m && m[1]) return m[1].trim();
    }
    return "";
  };

  const title =
    getMeta(["og:title", "twitter:title"]) ||
    (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "");

  const desc = getMeta(["og:description", "twitter:description", "description"]);
  const image = getMeta(["og:image", "twitter:image"]);

  return { title, desc, image };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // CDATA도 읽히게
  processEntities: true,
});

// RSS item에서 이미지 후보 찾기 (media:content, enclosure, image 등)
function pickRssImage(item, baseUrl) {
  // media:content
  const media = item["media:content"] || item["media:thumbnail"];
  if (media) {
    // 단일 or 배열
    const m = Array.isArray(media) ? media[0] : media;
    const u = m?.["@_url"] || m?.url || "";
    const abs = absolutizeUrl(baseUrl, u);
    if (abs) return abs;
  }

  // enclosure
  const enc = item.enclosure;
  if (enc) {
    const e = Array.isArray(enc) ? enc[0] : enc;
    const u = e?.["@_url"] || e?.url || "";
    const abs = absolutizeUrl(baseUrl, u);
    if (abs) return abs;
  }

  // some feeds use <image><url>...
  const img = item.image?.url || item.image?.["@_url"];
  if (img) {
    const abs = absolutizeUrl(baseUrl, img);
    if (abs) return abs;
  }

  return "";
}

function pickRssSummary(item) {
  // description / content:encoded 등
  const candidates = [
    item.description,
    item["content:encoded"],
    item.summary,
    item["media:description"],
  ];
  for (const c of candidates) {
    const t = stripHtml(c);
    if (t) return t;
  }
  return "";
}

function pickRssTitle(item) {
  return stripHtml(item.title || "") || "";
}

function pickRssLink(item) {
  // RSS2: link 문자열 / Atom: link[@_href]
  if (typeof item.link === "string") return safeUrl(item.link);
  if (item.link && typeof item.link === "object") {
    const href = item.link["@_href"] || item.link.href;
    return safeUrl(href);
  }
  return "";
}

function pickSourceName(feedUrl, feedObj) {
  // channel.title 같은 값
  const t =
    feedObj?.rss?.channel?.title ||
    feedObj?.feed?.title ||
    feedObj?.channel?.title ||
    "";
  const name = stripHtml(t);
  if (name) return name;
  try {
    return new URL(feedUrl).hostname;
  } catch {
    return "RSS";
  }
}

function padToLength(text, targetLen) {
  let t = String(text || "").trim();
  if (!t) t = "요약 내용이 아직 충분하지 않습니다. 원문 링크를 확인해 주세요.";
  const filler = [
    "이 이슈의 배경과 맥락을 함께 보면 이해가 쉬워요.",
    "제목만 보고 판단하지 말고 근거를 확인하는 습관이 중요합니다.",
    "다른 관점의 기사도 함께 읽어보면 균형 잡힌 시각을 만들 수 있어요.",
  ];
  let k = 0;
  while (t.length < targetLen) {
    t += " " + filler[k % filler.length];
    k++;
  }
  return t;
}

function makeBodiesFromRealSummary({ title, summary, sourceName, link }) {
  const s = summary || "";
  const src = sourceName || "출처";
  const url = link || "";

  const e = `
${title}

이번 주에 많이 언급된 기사예요.
간단히 핵심만 정리해 볼게요.

요약: ${truncate(s, 220) || "요약 정보를 가져오지 못했어요."}

원문을 직접 확인해 보세요:
${url}
`.trim();

  const m = `
${title}

이 기사는 이번 주에 특히 많이 다뤄졌습니다.

[핵심 요약]
${truncate(s, 520) || "요약 정보를 가져오지 못했습니다. 원문 링크를 참고하세요."}

[출처]
${src}
[원문]
${url}

읽을 때는 '사실'과 '의견(주장)'을 구분해보세요.
`.trim();

  const h = `
${title}

[요약]
${truncate(s, 900) || "요약 정보를 가져오지 못했습니다. 원문 링크를 참고하세요."}

[비판적 읽기 포인트]
- 어떤 '사실'이 확인 가능한가?
- 어떤 부분이 '해석/주장'인가?
- 제목과 본문이 같은 방향으로 근거를 제시하는가?
- 같은 사건을 다른 매체는 어떻게 다루는가?

[출처]
${src}
[원문]
${url}
`.trim();

  return {
    elementary: `<p>${padToLength(e, TARGET.elementary).replace(/\n+/g, "</p><p>")}</p>`,
    middle: `<p>${padToLength(m, TARGET.middle).replace(/\n+/g, "</p><p>")}</p>`,
    high: `<p>${padToLength(h, TARGET.high).replace(/\n+/g, "</p><p>")}</p>`,
  };
}

function makeSummaries(summary) {
  const s = summary || "";
  return {
    elementary: truncate(s, 180) || "",
    middle: truncate(s, 260) || "",
    high: truncate(s, 340) || "",
  };
}

function keywordPack() {
  return [
    { word: "source", meaning: "출처", example: "Check the source." },
    { word: "claim", meaning: "주장", example: "He made a claim." },
    { word: "evidence", meaning: "근거", example: "We need evidence." },
    { word: "context", meaning: "맥락", example: "Context matters." },
    { word: "impact", meaning: "영향", example: "It has impact." },
    { word: "debate", meaning: "논쟁", example: "The debate continues." },
    { word: "policy", meaning: "정책", example: "A new policy." },
    { word: "trend", meaning: "추세", example: "A recent trend." },
    { word: "verify", meaning: "검증하다", example: "Verify the facts." },
  ];
}

// ---- main pipeline ----
async function loadFeedItems(feedUrl) {
  const xml = await fetchText(feedUrl, 12000);
  if (!xml) return [];

  let parsed;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return [];
  }

  // RSS2
  const channel = parsed?.rss?.channel;
  if (channel?.item) {
    const items = Array.isArray(channel.item) ? channel.item : [channel.item];
    const sourceName = pickSourceName(feedUrl, parsed);
    return items.map((it) => ({
      sourceName,
      title: pickRssTitle(it),
      link: pickRssLink(it),
      summary: pickRssSummary(it),
      image: pickRssImage(it, feedUrl),
      pubDate: it.pubDate || it.date || "",
      feedUrl,
    }));
  }

  // Atom
  const feed = parsed?.feed;
  if (feed?.entry) {
    const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];
    const sourceName = pickSourceName(feedUrl, parsed);
    return entries.map((en) => {
      const title = stripHtml(en.title || "");
      const link = safeUrl(en.link?.["@_href"] || en.link?.href || "");
      const summary = stripHtml(en.summary || en.content || "");
      return {
        sourceName,
        title,
        link,
        summary,
        image: "",
        pubDate: en.updated || en.published || "",
        feedUrl,
      };
    });
  }

  return [];
}

async function enrichWithOg(item) {
  // link 없으면 못함
  if (!item.link) return item;

  // 이미지/요약/제목이 없으면 OG로 보강
  const needTitle = !item.title;
  const needSummary = !item.summary || item.summary.length < 40;
  const needImage = !item.image;

  if (!needTitle && !needSummary && !needImage) return item;

  const html = await fetchText(item.link, 12000);
  if (!html) return item;

  const og = extractOg(html);
  const out = { ...item };

  if (needTitle && og.title) out.title = og.title;
  if (needSummary && og.desc) out.summary = stripHtml(og.desc);
  if (needImage && og.image) out.image = absolutizeUrl(item.link, og.image) || out.image;

  return out;
}

async function main() {
  if (!FEEDS.length) {
    console.log(DEFAULT_FEEDS_MESSAGE);
    // 그래도 빈 이슈 생성은 막기
  }

  ensureDir(DATA_DIR);
  ensureDir(ISSUES_DIR);

  const dateStr = formatDate(new Date());
  const newIssue = process.env.ISSUE ? Number(process.env.ISSUE) : getNextIssueNumber();
  const wantCount = Number(process.env.COUNT || DEFAULT_ARTICLE_COUNT);

  // 1) 모든 피드에서 item 수집
  const all = [];
  for (const f of FEEDS) {
    const items = await loadFeedItems(f);
    all.push(...items);
  }

  // 2) 링크 기준 중복 제거, 빈 것 제거
  const cleaned = all
    .map((x) => ({
      ...x,
      title: String(x.title || "").trim(),
      summary: String(x.summary || "").trim(),
      link: safeUrl(x.link),
      image: safeUrl(x.image),
    }))
    .filter((x) => x.link && x.title);

  // 3) 최신/상위 선택: pubDate로 대충 정렬 (없으면 뒤로)
  cleaned.sort((a, b) => String(b.pubDate || "").localeCompare(String(a.pubDate || "")));

  // 4) 상위 N개 고르고 OG로 보강
  const pickedBase = dedupeKeepOrder(cleaned.map((x) => x.link))
    .slice(0, Math.max(wantCount * 2, 30)) // OG 실패 대비 여유
    .map((u) => cleaned.find((x) => x.link === u))
    .filter(Boolean);

  const picked = [];
  for (const it of pickedBase) {
    const enriched = await enrichWithOg(it);
    // summary가 너무 빈 경우라도 title/link만 있으면 body에서 링크는 보여주게 함
    picked.push(enriched);
    if (picked.length >= wantCount) break;
  }

  // 5) issues JSON 생성
  const ARTICLES = {};
  for (let i = 0; i < picked.length; i++) {
    const it = picked[i];

    const title = truncate(it.title, 120);
    const summary = it.summary ? truncate(it.summary, 1200) : "";
    const link = it.link;
    const sourceName = it.sourceName;

    // 이미지: RSS/OG → 없으면 로컬 fallback
    let img = it.image;
    if (!img) img = fallbackImageByIndex(i);

    const bodies = makeBodiesFromRealSummary({ title, summary, sourceName, link });

    ARTICLES[String(i + 1)] = {
      title: {
        elementary: title,
        middle: title,
        high: title,
      },
      summary: makeSummaries(summary),
      body: bodies, // ✅ 항상 생성
      image: {
        elementary: img,
        middle: img,
        high: img,
      },
      imageAlt: {
        elementary: title,
        middle: title,
        high: title,
      },
      keywords: keywordPack(),
      links: [link],
      meta: {
        kind: "weekly-rss",
        sourceName,
        feedUrl: it.feedUrl,
        pubDate: it.pubDate || "",
      },
    };
  }

  // 6) 기사 0개면: 안전장치로 더미 1개 생성(빈 페이지 방지)
  if (Object.keys(ARTICLES).length === 0) {
    const msg = FEEDS.length ? "피드에서 기사를 가져오지 못했습니다." : DEFAULT_FEEDS_MESSAGE;
    ARTICLES["1"] = {
      title: { elementary: "기사 수집 실패", middle: "기사 수집 실패", high: "기사 수집 실패" },
      summary: { elementary: msg, middle: msg, high: msg },
      body: {
        elementary: `<p>${msg}</p>`,
        middle: `<p>${msg}</p>`,
        high: `<p>${msg}</p>`,
      },
      image: {
        elementary: fallbackImageByIndex(0),
        middle: fallbackImageByIndex(0),
        high: fallbackImageByIndex(0),
      },
      imageAlt: { elementary: "fallback", middle: "fallback", high: "fallback" },
      keywords: keywordPack(),
      links: [],
      meta: { kind: "weekly-rss", error: true },
    };
  }

  const payload = {
    issue: newIssue,
    date: dateStr,
    source: "scripts/generate-weekly.js",
    ARTICLES,
  };

  const outFile = path.join(ISSUES_DIR, `${newIssue}.json`);
  writeJson(outFile, payload);
  upsertIndex(newIssue, dateStr);

  console.log(`[OK] generated weekly issue ${newIssue} (${dateStr}) -> data/issues/${newIssue}.json`);
}

main();