// scripts/generate-weekly.js
// 기능:
// 1) RSS에서 제목/요약/링크 수집
// 2) RSS에 이미지 없으면 원문 HTML에서 og:image/og:description 추출
// 3) 주제(topic) 분류 -> 같은 주제는 최대 2개만 채택
// 4) 초/중/고 제목/요약/본문을 "완전히 다른 구성"으로 생성 (규칙 기반)
// 5) body는 항상 존재(빈 기사 방지)
// 6) data/issues/<newIssue>.json + data/issues.json 갱신
//
// Node 18+ 필요

import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const ISSUES_DIR = path.join(DATA_DIR, "issues");
const INDEX_FILE = path.join(DATA_DIR, "issues.json");

// ✅ 여기 RSS만 채우면 바로 동작
const FEEDS = [
  // 예시:
  // "https://www.hani.co.kr/rss/",
  // "https://www.khan.co.kr/rss/rssdata/total_news.xml",
  // "https://rss.donga.com/total.xml",
];

// 최후 fallback 로컬 이미지
const LOCAL_FALLBACK_IMAGES = [
  "images/chocolate.jpg",
  "images/dict.jpg",
  "images/planet.jpg",
  "images/tteokguk.jpg",
  "images/default-elementary.jpg",
  "images/default-middle.jpg",
  "images/default-high.jpg",
].filter((p) => fs.existsSync(path.join(ROOT, p)));

const DEFAULT_FEEDS_MESSAGE =
  "FEEDS가 비어있습니다. scripts/generate-weekly.js의 FEEDS 배열에 RSS URL을 추가하세요.";

const DEFAULT_ARTICLE_COUNT = 12; // 고등 기준
const MAX_PER_TOPIC = 2;

// 레벨별 길이(대략)
const TARGET = { elementary: 380, middle: 900, high: 1500 };

// -------- utils --------
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
function dedupeBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
function tokensKo(s) {
  // 아주 단순 토크나이저(한글/영문/숫자)
  return String(s || "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}
function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
}
function padToLength(text, targetLen) {
  let t = String(text || "").trim();
  if (!t) t = "요약 정보를 가져오지 못했어요. 원문 링크를 확인해 주세요.";
  const filler = [
    "핵심은 사실과 주장을 구분해서 읽는 것입니다.",
    "제목만 보고 판단하지 말고 근거를 확인해 보세요.",
    "다른 출처의 기사도 함께 읽으면 이해가 더 깊어집니다.",
  ];
  let k = 0;
  while (t.length < targetLen) {
    t += " " + filler[k % filler.length];
    k++;
  }
  return t;
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

// -------- HTTP --------
async function fetchText(url, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "jp-times-bot/1.0 (+https://news-evh.pages.dev)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

// -------- RSS parsing --------
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: true,
});

function pickRssTitle(item) {
  return stripHtml(item.title || "") || "";
}
function pickRssSummary(item) {
  const candidates = [item.description, item["content:encoded"], item.summary, item["media:description"]];
  for (const c of candidates) {
    const t = stripHtml(c);
    if (t) return t;
  }
  return "";
}
function pickRssLink(item) {
  if (typeof item.link === "string") return safeUrl(item.link);
  if (item.link && typeof item.link === "object") {
    const href = item.link["@_href"] || item.link.href;
    return safeUrl(href);
  }
  return "";
}
function pickRssImage(item, baseUrl) {
  const media = item["media:content"] || item["media:thumbnail"];
  if (media) {
    const m = Array.isArray(media) ? media[0] : media;
    const u = m?.["@_url"] || m?.url || "";
    const abs = absolutizeUrl(baseUrl, u);
    if (abs) return abs;
  }
  const enc = item.enclosure;
  if (enc) {
    const e = Array.isArray(enc) ? enc[0] : enc;
    const u = e?.["@_url"] || e?.url || "";
    const abs = absolutizeUrl(baseUrl, u);
    if (abs) return abs;
  }
  return "";
}
function pickSourceName(feedUrl, parsed) {
  const t = parsed?.rss?.channel?.title || parsed?.feed?.title || "";
  const name = stripHtml(t);
  if (name) return name;
  try {
    return new URL(feedUrl).hostname;
  } catch {
    return "RSS";
  }
}

async function loadFeedItems(feedUrl) {
  const xml = await fetchText(feedUrl, 15000);
  if (!xml) return [];

  let parsed;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return [];
  }

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
      return { sourceName, title, link, summary, image: "", pubDate: en.updated || en.published || "", feedUrl };
    });
  }

  return [];
}

async function enrichWithOg(item) {
  if (!item.link) return item;
  const needTitle = !item.title;
  const needSummary = !item.summary || item.summary.length < 40;
  const needImage = !item.image;

  if (!needTitle && !needSummary && !needImage) return item;

  const html = await fetchText(item.link, 15000);
  if (!html) return item;

  const og = extractOg(html);
  const out = { ...item };

  if (needTitle && og.title) out.title = stripHtml(og.title);
  if (needSummary && og.desc) out.summary = stripHtml(og.desc);
  if (needImage && og.image) out.image = absolutizeUrl(item.link, og.image) || out.image;

  return out;
}

// -------- topic + diversity --------
const STOPWORDS = new Set([
  "기자","단독","속보","오늘","이번","관련","대한","위해","통해","및","등","에서","으로","입니다","한다","했다",
  "the","and","for","with","from","that","this","are","was","were",
]);

// 아주 단순한 토픽 규칙(키워드로 분류). 필요하면 확장 가능.
const TOPIC_RULES = [
  { topic: "정치", keys: ["대통령","국회","총리","선거","여당","야당","정당","정치","탄핵","공천","의원"] },
  { topic: "경제", keys: ["금리","환율","주가","증시","물가","부동산","고용","수출","경제","투자","은행"] },
  { topic: "사회", keys: ["사건","사고","범죄","경찰","법원","재판","폭행","사기","사회","노동","파업"] },
  { topic: "국제", keys: ["미국","중국","일본","러시아","우크라","이스라","가자","유엔","정상회담","외교","국제"] },
  { topic: "과학/기술", keys: ["AI","인공지능","반도체","로봇","우주","위성","과학","기술","연구","데이터","모델"] },
  { topic: "환경", keys: ["기후","탄소","온실가스","폭염","홍수","미세먼지","환경","재활용","산불","해수면"] },
  { topic: "교육", keys: ["학교","학생","교사","교육","수능","입시","교과","학습","대학","급식"] },
  { topic: "문화", keys: ["영화","드라마","음악","전시","책","문학","공연","문화","예술","축제"] },
  { topic: "스포츠", keys: ["경기","리그","우승","선수","감독","축구","야구","농구","올림픽","스포츠"] },
];

function classifyTopic(text) {
  const t = String(text || "");
  for (const r of TOPIC_RULES) {
    if (r.keys.some((k) => t.includes(k))) return r.topic;
  }
  return "기타";
}

// 같은 주제에서도 “내용이 완전 다르게” 보이도록
// - 서로 유사한 기사(제목+요약 토큰 유사도 높은 것)는 하나만 남김
function isTooSimilar(candidate, chosenInSameTopic) {
  const ct = tokensKo(candidate.title + " " + candidate.summary);
  for (const c of chosenInSameTopic) {
    const tt = tokensKo(c.title + " " + c.summary);
    if (jaccard(ct, tt) >= 0.42) return true; // 꽤 엄격
  }
  return false;
}

// -------- rewrite (rule-based, different per level) --------
function makeTitles(baseTitle, topic) {
  const t = truncate(baseTitle, 70);
  // “말투/구성”을 다르게
  return {
    elementary: truncate(`${topic} 소식 한눈에: ${t}`, 80),
    middle: truncate(`${topic} 이슈 핵심 정리 — ${t}`, 90),
    high: truncate(`${topic} 쟁점·맥락 분석: ${t}`, 100),
  };
}

function makeSummaries(summary, topic) {
  const s = stripHtml(summary);
  // 같은 요약이라도 3레벨이 서로 “형식”을 완전히 다르게
  const e = padToLength(
    `무슨 일인가요? ${truncate(s, 150) || "요약 정보를 가져오지 못했어요."} ` +
    `중요한 단어를 찾아보며 읽어보세요.`,
    200
  );

  const m = padToLength(
    `핵심 한 줄: ${truncate(s, 220) || "요약 정보를 가져오지 못했어요."}\n` +
    `- 배경: (왜 이슈가 됐는지)\n- 쟁점: (무엇이 논쟁인지)\n- 영향: (우리에게 어떤 의미인지)`,
    320
  );

  const h = padToLength(
    `요약: ${truncate(s, 320) || "요약 정보를 가져오지 못했어요."}\n` +
    `분석 관점: 프레이밍/근거의 질/이해관계자/대안 가능성.\n` +
    `스스로 질문: "무엇이 사실인가?", "누가 이득을 보는가?", "반대 근거는?"`,
    420
  );

  return { elementary: e, middle: m, high: h };
}

function makeBodies({ title, summary, sourceName, link, topic }) {
  const s = stripHtml(summary);

  // 초등: 스토리/질문 중심
  const eText = padToLength(
    `${title}\n\n` +
    `이번 주에 사람들이 많이 이야기한 ${topic} 소식이에요.\n` +
    `간단히 말하면: ${truncate(s, 220) || "요약 정보를 가져오지 못했어요."}\n\n` +
    `생각해 보기:\n` +
    `1) 왜 이 일이 중요할까요?\n` +
    `2) 우리 생활과 어떤 점이 연결될까요?\n\n` +
    `원문 링크: ${link}`,
    TARGET.elementary
  );

  // 중등: 3단 구성(요약/배경/시사점) + 체크리스트
  const mText = padToLength(
    `${title}\n\n` +
    `[1) 요약]\n${truncate(s, 420) || "요약 정보를 가져오지 못했습니다. 원문 링크를 참고하세요."}\n\n` +
    `[2) 배경/맥락]\n이 이슈가 커진 이유를 '누가, 무엇을, 왜' 관점에서 정리해 보세요.\n\n` +
    `[3) 시사점]\n비슷한 사건이 반복되면 어떤 제도/규칙이 필요할까요?\n\n` +
    `체크리스트:\n- 사실(확인된 정보) vs 주장(의견) 구분했나?\n- 출처(${sourceName})를 확인했나?\n\n` +
    `원문 링크: ${link}`,
    TARGET.middle
  );

  // 고등: 분석틀 + 반론 가능성 + 질문 3개
  const hText = padToLength(
    `${title}\n\n` +
    `[핵심 요약]\n${truncate(s, 650) || "요약 정보를 가져오지 못했습니다. 원문 링크를 참고하세요."}\n\n` +
    `[분석 프레임]\n` +
    `- 이해관계자: 누가 이득/손해를 보는가?\n` +
    `- 근거의 질: 수치/문서/공식발표/검증 가능한가?\n` +
    `- 프레이밍: 제목/표현이 특정 해석을 유도하는가?\n` +
    `- 대안: 현실적 해결책은 무엇인가?\n\n` +
    `[반론/다른 관점]\n같은 사건을 다른 매체는 어떻게 설명할지 가정해보세요.\n\n` +
    `스스로 질문(3개):\n` +
    `1) 핵심 주장에 대한 가장 강한 근거는?\n` +
    `2) 반대 근거가 있다면 무엇일까?\n` +
    `3) 장기적으로 어떤 변화가 생길까?\n\n` +
    `원문 링크: ${link}`,
    TARGET.high
  );

  const toHtmlP = (txt) => `<p>${String(txt).trim().replace(/\n+/g, "</p><p>")}</p>`;

  return {
    elementary: toHtmlP(eText),
    middle: toHtmlP(mText),
    high: toHtmlP(hText),
  };
}

function keywordPack(topic) {
  // topic을 섞어서 단어도 다양하게
  const base = [
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
  // topic에 따라 순서를 살짝 바꿔서 “같은 느낌” 줄이기
  const shift = Math.abs(tokensKo(topic).join("").length) % base.length;
  return base.slice(shift).concat(base.slice(0, shift));
}

// -------- main --------
async function main() {
  ensureDir(DATA_DIR);
  ensureDir(ISSUES_DIR);

  const dateStr = formatDate(new Date());
  const newIssue = process.env.ISSUE ? Number(process.env.ISSUE) : getNextIssueNumber();
  const wantCount = Number(process.env.COUNT || DEFAULT_ARTICLE_COUNT);

  if (!FEEDS.length) {
    console.log(DEFAULT_FEEDS_MESSAGE);
  }

  // 1) RSS items 수집
  const all = [];
  for (const f of FEEDS) {
    const items = await loadFeedItems(f);
    all.push(...items);
  }

  // 2) 정리(링크/제목 필수)
  let cleaned = all
    .map((x) => ({
      ...x,
      title: String(x.title || "").trim(),
      summary: String(x.summary || "").trim(),
      link: safeUrl(x.link),
      image: safeUrl(x.image),
    }))
    .filter((x) => x.link && x.title);

  // 3) 중복 링크 제거
  cleaned = dedupeBy(cleaned, (x) => x.link);

  // 4) pubDate 기준 대충 정렬
  cleaned.sort((a, b) => String(b.pubDate || "").localeCompare(String(a.pubDate || "")));

  // 5) OG 보강(제목/요약/이미지)
  const enriched = [];
  for (const it of cleaned.slice(0, Math.max(wantCount * 4, 40))) {
    enriched.push(await enrichWithOg(it));
  }

  // 6) topic 분류 + topic별 최대 2개 + 같은 topic 내 유사 기사 제거
  const byTopicCount = new Map();         // topic -> count
  const chosenByTopic = new Map();        // topic -> items[]
  const chosen = [];

  for (const it of enriched) {
    const title = stripHtml(it.title);
    const summary = stripHtml(it.summary);
    const topic = classifyTopic(title + " " + summary);

    const cnt = byTopicCount.get(topic) || 0;
    if (cnt >= MAX_PER_TOPIC) continue;

    const listInTopic = chosenByTopic.get(topic) || [];
    if (isTooSimilar({ title, summary }, listInTopic)) continue;

    chosen.push({ ...it, title, summary, topic });
    listInTopic.push({ title, summary });
    chosenByTopic.set(topic, listInTopic);
    byTopicCount.set(topic, cnt + 1);

    if (chosen.length >= wantCount) break;
  }

  // 7) 기사 0개면 안전 더미
  const ARTICLES = {};
  if (!chosen.length) {
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
      keywords: keywordPack("기타"),
      links: [],
      meta: { kind: "weekly-rss", error: true },
    };
  } else {
    // 8) 포맷 만들기(초/중/고 완전 다른 버전)
    for (let i = 0; i < chosen.length; i++) {
      const it = chosen[i];
      const link = it.link;
      const sourceName = it.sourceName || "RSS";
      const topic = it.topic;

      const baseTitle = it.title;
      const baseSummary = it.summary;

      let img = it.image || "";
      if (!img) img = fallbackImageByIndex(i);

      const titles = makeTitles(baseTitle, topic);
      const summaries = makeSummaries(baseSummary, topic);
      const bodies = makeBodies({
        title: titles.high, // 본문에는 고등 타이틀을 대표로 사용해도 되고, 아래에서 각 레벨에서 따로 넣는 구조도 가능
        summary: baseSummary,
        sourceName,
        link,
        topic,
      });

      ARTICLES[String(i + 1)] = {
        title: titles,
        summary: summaries,
        body: bodies, // ✅ 무조건 존재
        image: { elementary: img, middle: img, high: img },
        imageAlt: { elementary: titles.elementary, middle: titles.middle, high: titles.high },
        keywords: keywordPack(topic),
        links: [link],
        meta: {
          kind: "weekly-rss",
          topic,
          sourceName,
          feedUrl: it.feedUrl || "",
          pubDate: it.pubDate || "",
        },
      };
    }
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