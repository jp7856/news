// scripts/generate-weekly.js
// 목적: "교육기사 포맷"과 동일한 issues JSON 생성 (title/body/image가 레벨별로 항상 존재)
// - data/issues.json 최신 issue+1로 새 호수 생성
// - data/issues/<newIssue>.json 생성
// - 본문이 비어있는 기사(클릭 시 빈 화면) 방지: body/summary를 항상 채움

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const ISSUES_DIR = path.join(DATA_DIR, "issues");
const INDEX_FILE = path.join(DATA_DIR, "issues.json");

// 프로젝트에 이미 있는 로컬 이미지들(없어도 동작)
const LOCAL_IMAGES = [
  "images/chocolate.jpg",
  "images/dict.jpg",
  "images/planet.jpg",
  "images/tteokguk.jpg",
];

// 레벨별 목표 길이(대략)
const TARGET = {
  elementary: 400,
  middle: 1000,
  high: 2000,
};

// ------- 유틸 -------
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
  // YYYY.MM.DD
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`;
}

function getNextIssueNumber() {
  const idx = readJson(INDEX_FILE, []);
  const max = idx.reduce((acc, it) => Math.max(acc, Number(it.issue) || 0), 0);
  return max ? max + 1 : 1061; // 처음이면 1061부터
}

function upsertIndex(issueNo, dateStr) {
  const idx = readJson(INDEX_FILE, []);
  const next = [{ issue: Number(issueNo), date: dateStr }, ...idx.filter(x => Number(x.issue) !== Number(issueNo))];
  writeJson(INDEX_FILE, next);
}

function pickImage(i) {
  const img = LOCAL_IMAGES[i % LOCAL_IMAGES.length];
  return {
    elementary: img,
    middle: img,
    high: img,
  };
}

function padToLength(text, targetLen) {
  // 너무 짧으면 자연스럽게 문장을 덧붙여 길이를 맞춤
  let t = (text || "").trim();
  if (!t) t = "내용을 준비 중입니다.";

  const filler = [
    "이 내용을 이해하면 중요한 배경을 알 수 있어요.",
    "핵심은 왜 이런 일이 일어났는지 생각해 보는 거예요.",
    "관련 사례를 함께 보면 이해가 더 쉬워집니다.",
    "마지막으로 정리하면, 중요한 포인트는 원인과 결과입니다.",
  ];

  let k = 0;
  while (t.length < targetLen) {
    t += (t.endsWith(".") || t.endsWith("요") || t.endsWith("다") ? " " : " ") + filler[k % filler.length];
    k++;
  }
  return t;
}

function makeBody({ headline, sourceName, angle }, level) {
  // 레벨별 톤/구성
  if (level === "elementary") {
    const base = `
${headline}

이번 주에 사람들이 많이 이야기한 소식이에요.
어떤 일이 있었는지 간단히 살펴볼게요.

- 누가/무엇이: ${sourceName || "여러 매체"}
- 무엇이 일어났나: ${angle || "주요 사건이 큰 관심을 받았어요."}

왜 중요할까요?
이 소식은 우리 생활과 사회의 흐름을 이해하는 데 도움이 돼요.
`.trim();
    return `<p>${padToLength(base, TARGET.elementary).replace(/\n+/g, "</p><p>")}</p>`;
  }

  if (level === "middle") {
    const base = `
${headline}

이 이슈는 이번 주에 특히 주목을 받았습니다.
핵심 쟁점은 "무엇이 문제인가"와 "왜 논쟁이 커졌는가"입니다.

1) 사건/이슈 요약
${angle || "여러 이해관계가 얽히면서 논쟁이 확산되었습니다."}

2) 배경
사건이 벌어지기 전 상황과 관련 제도/환경이 영향을 줄 수 있습니다.

3) 시사점
정보를 볼 때는 출처가 무엇인지, 주장과 사실이 구분되는지 확인하는 태도가 필요합니다.
`.trim();
    return `<p>${padToLength(base, TARGET.middle).replace(/\n+/g, "</p><p>")}</p>`;
  }

  // high
  const base = `
${headline}

이번 이슈는 사회적 관심이 집중되며 담론이 빠르게 확대되었습니다. 단순 사건 보도를 넘어, 프레이밍(어떤 관점으로 해석하느냐)과 확증 편향, 플랫폼 확산 구조(알고리즘/커뮤니티)까지 함께 고려할 필요가 있습니다.

1) 핵심 사실과 주장 분리
- 사실: 확인 가능한 정보(공식 발표, 문서, 객관 자료)
- 주장: 해석, 의견, 추정, 정치적/이해관계적 메시지

2) 확산 메커니즘
같은 사건이라도 매체/커뮤니티에 따라 강조점이 달라집니다. 제목과 요약은 클릭을 유도하도록 설계될 수 있으므로, 본문 근거와 원문 출처 확인이 중요합니다.

3) 의미(시사점)
이 이슈는 제도·정책, 사회적 신뢰, 법·윤리 기준, 그리고 집단 심리의 상호작용을 드러냅니다. 관찰 포인트는 (a) 누가 이득/손해를 보는가, (b) 근거의 질이 충분한가, (c) 대안은 현실적인가 입니다.

4) 정리 질문
- 가장 강한 근거는 무엇인가?
- 반대 관점에서 약점은 무엇인가?
- 장기적으로 어떤 변화가 생길 수 있는가?
`.trim();
  return `<p>${padToLength(base, TARGET.high).replace(/\n+/g, "</p><p>")}</p>`;
}

function makeKeywords(level) {
  const base = [
    { word: "issue", meaning: "문제/이슈", example: "This issue is important." },
    { word: "source", meaning: "출처", example: "Check the source of the news." },
    { word: "claim", meaning: "주장", example: "He made a claim without evidence." },
    { word: "evidence", meaning: "근거", example: "We need evidence to support it." },
    { word: "context", meaning: "맥락", example: "Context helps understanding." },
    { word: "impact", meaning: "영향", example: "It can impact society." },
    { word: "debate", meaning: "논쟁", example: "The debate continues." },
    { word: "policy", meaning: "정책", example: "A new policy was announced." },
    { word: "trend", meaning: "추세", example: "This is a recent trend." },
  ];

  const count = { elementary: 5, middle: 7, high: 9 }[level] || 5;
  return base.slice(0, count);
}

function makeArticle(i, dateStr) {
  const topicList = [
    "정치", "경제", "사회", "과학", "문화", "교육", "환경", "국제", "기술", "스포츠"
  ];
  const topic = topicList[i % topicList.length];

  const headline = `[핫이슈] 이번 주 많이 다뤄진 이슈: ${topic} 관련 이슈 ${i + 1}`;
  const sourceName = "주간 자동뉴스";
  const angle = `${topic} 분야에서 논쟁과 관심이 커지며 다양한 의견이 제기되었습니다.`;

  return {
    title: {
      elementary: `${topic} 이슈 쉽게 보기 ${i + 1}`,
      middle: `${topic} 이슈 정리 ${i + 1}`,
      high: `${topic} 이슈 심화 분석 ${i + 1}`,
    },
    // ✅ 핵심: body를 반드시 채움
    body: {
      elementary: makeBody({ headline, sourceName, angle }, "elementary"),
      middle: makeBody({ headline, sourceName, angle }, "middle"),
      high: makeBody({ headline, sourceName, angle }, "high"),
    },
    // summary도 채워두면 list에서 필터링/검색하기 편함
    summary: {
      elementary: padToLength(`${topic} 관련 이슈를 쉬운 말로 요약합니다.`, 180),
      middle: padToLength(`${topic} 관련 핵심 쟁점과 배경을 요약합니다.`, 260),
      high: padToLength(`${topic} 이슈를 사실/주장/확산 구조 관점에서 요약합니다.`, 340),
    },
    image: pickImage(i),
    imageAlt: {
      elementary: `${topic} 관련 이미지`,
      middle: `${topic} 관련 이미지`,
      high: `${topic} 관련 이미지`,
    },
    keywords: makeKeywords("high"), // 키워드는 공통으로 조금 넉넉히 넣고, article에서 레벨별로 잘라 사용
    // 출처 링크(있으면 article에서 보여줄 수 있음)
    links: [],
    meta: {
      kind: "weekly-auto",
      topic,
      date: dateStr,
    },
  };
}

function main() {
  ensureDir(DATA_DIR);
  ensureDir(ISSUES_DIR);

  const dateStr = formatDate(new Date());
  const newIssue = process.env.ISSUE ? Number(process.env.ISSUE) : getNextIssueNumber();

  const articleCount = Number(process.env.COUNT || 12); // 고등 12개 기준
  const ARTICLES = {};
  for (let i = 0; i < articleCount; i++) {
    ARTICLES[String(i + 1)] = makeArticle(i, dateStr);
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