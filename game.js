const EN_DIFFICULTIES = ["A1", "A2", "B1", "B2", "C1", "C2"];
const LANGUAGES = ["en", "cn"];
const CN_CATEGORIES = ["word", "idiom"]; // only used when language === "cn"
const CN_DIFFICULTIES = ["normal", "hard"]; // only used when language === "cn"

function clampToAllowed(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function modeKey(mode) {
  const lang   = clampToAllowed(mode?.language, LANGUAGES, "en");
  const diff   = clampToAllowed(mode?.difficulty, EN_DIFFICULTIES, "B1");
  const cat    = lang === "cn" ? clampToAllowed(mode?.category, CN_CATEGORIES, "word") : "word";
  const cnDiff = lang === "cn" ? clampToAllowed(mode?.cnDifficulty, CN_DIFFICULTIES, "normal") : "normal";
  return `${lang}:${cat}:${diff}:${cnDiff}`;
}

function normalizeMode(mode) {
  const lang   = clampToAllowed(mode?.language, LANGUAGES, "en");
  const diff   = clampToAllowed(mode?.difficulty, EN_DIFFICULTIES, "B1");
  const cat    = lang === "cn" ? clampToAllowed(mode?.category, CN_CATEGORIES, "word") : "word";
  const cnDiff = lang === "cn" ? clampToAllowed(mode?.cnDifficulty, CN_DIFFICULTIES, "normal") : "normal";
  return { language: lang, category: cat, difficulty: diff, cnDifficulty: cnDiff };
}

// Cached DB promise — fetched once, reused across all loadLexicon calls.
let _dbPromise = null;

async function getDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    const SQL = await window.initSqlJs({
      locateFile: (file) => `./${file}`,
    });
    const resp = await fetch("./words.db");
    if (!resp.ok) throw new Error("Failed to load words.db");
    const buf = await resp.arrayBuffer();
    return new SQL.Database(new Uint8Array(buf));
  })();
  return _dbPromise;
}

async function loadLexicon(mode) {
  const m = normalizeMode(mode);
  const db = await getDb();

  let stmt, rows;
  if (m.language === "en") {
    stmt = db.prepare("SELECT word FROM words WHERE language = 'en' AND difficulty = :diff");
    stmt.bind({ ":diff": m.difficulty });
    rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject().word);
    stmt.free();

    // Fallback: old DB used 'easy'/'medium'/'hard'; map to nearest CEFR bucket
    if (rows.length === 0) {
      const legacyMap = { A1: "easy", A2: "easy", B1: "medium", B2: "medium", C1: "hard", C2: "hard" };
      const legacyDiff = legacyMap[m.difficulty] ?? "medium";
      stmt = db.prepare("SELECT word FROM words WHERE language = 'en' AND difficulty = :diff");
      stmt.bind({ ":diff": legacyDiff });
      while (stmt.step()) rows.push(stmt.getAsObject().word);
      stmt.free();
    }

    // Last resort: any English word in the DB
    if (rows.length === 0) {
      stmt = db.prepare("SELECT word FROM words WHERE language = 'en'");
      while (stmt.step()) rows.push(stmt.getAsObject().word);
      stmt.free();
    }
  } else {
    // Try with difficulty filter first
    stmt = db.prepare("SELECT word FROM words WHERE language = 'cn' AND category = :cat AND difficulty = :cnDiff");
    stmt.bind({ ":cat": m.category, ":cnDiff": m.cnDifficulty });
    rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject().word);
    stmt.free();

    // Fallback: if empty (e.g. DB built before difficulty was split), ignore the filter
    if (rows.length === 0) {
      stmt = db.prepare("SELECT word FROM words WHERE language = 'cn' AND category = :cat");
      stmt.bind({ ":cat": m.category });
      while (stmt.step()) rows.push(stmt.getAsObject().word);
      stmt.free();
    }
  }

  if (m.language === "en") {
    return rows.map((s) => s.toLowerCase()).filter((s) => /^[a-z]{3,}$/.test(s));
  }

  // Chinese: strip non-Han characters just in case
  const hanOnly = rows
    .map((s) => String(s).replace(/[^\u4E00-\u9FFF]/g, ""))
    .filter(Boolean);

  if (m.category === "idiom") return hanOnly.filter((s) => Array.from(s).length === 4);
  return hanOnly.filter((s) => {
    const n = Array.from(s).length;
    return n >= 2 && n <= 8;
  });
}

function dateKeyLocalYYYYMMDD(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDailyWord(words, dateKey, namespace = "ConnWords") {
  if (!Array.isArray(words) || words.length === 0) throw new Error("Empty word list");
  const seed = fnv1a32(`${namespace}|${dateKey}`);
  const rand = mulberry32(seed);
  const idx = Math.floor(rand() * words.length);
  return words[idx];
}

function normalizeGuess(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

function normalizeGuessCn(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[^\u4E00-\u9FFF]/g, "");
}

function letterCounts(word) {
  const m = new Map();
  for (const ch of word) m.set(ch, (m.get(ch) ?? 0) + 1);
  return m;
}

function overlapCount(a, b) {
  const ca = letterCounts(a);
  const cb = letterCounts(b);
  let n = 0;
  for (const [ch, cntA] of ca.entries()) {
    const cntB = cb.get(ch) ?? 0;
    n += Math.min(cntA, cntB);
  }
  return n;
}

function positionalMatches(a, b) {
  const n = Math.min(a.length, b.length);
  let hit = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) hit++;
  return hit;
}

function editDistance(a, b) {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const m = aa.length;
  const n = bb.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// Returns an array of 'green' | 'yellow' | 'none' for each character of guess.
// Green = correct char at correct position; yellow = char in answer but wrong position.
// Handles duplicate characters correctly (Wordle-style).
function scoreGuessChars(guess, answer) {
  const gArr = Array.from(guess);
  const aArr = Array.from(answer);
  const result = new Array(gArr.length).fill("none");
  const answerPool = [...aArr];

  // First pass: greens
  for (let i = 0; i < gArr.length; i++) {
    if (i < aArr.length && gArr[i] === aArr[i]) {
      result[i] = "green";
      answerPool[i] = null;
    }
  }

  // Second pass: yellows
  for (let i = 0; i < gArr.length; i++) {
    if (result[i] === "green") continue;
    const j = answerPool.indexOf(gArr[i]);
    if (j !== -1) {
      result[i] = "yellow";
      answerPool[j] = null;
    }
  }

  return result;
}

function charHitSummary(guess, answer, bracketChar) {
  const gArr = Array.from(guess);
  const scored = scoreGuessChars(guess, answer);
  const greens  = gArr.filter((_, i) => scored[i] === "green");
  const yellows = gArr.filter((_, i) => scored[i] === "yellow");
  const br = bracketChar === "cn" ? (c) => `「${c}」` : (c) => `"${c}"`;
  const parts = [];
  if (greens.length)  parts.push(`位置正确：${greens.map(br).join(" ")}`);
  if (yellows.length) parts.push(`有但位置错：${yellows.map(br).join(" ")}`);
  return parts.length ? parts.join("；") : "无命中字符";
}

function generateHint(guess, answer, attemptIndex) {
  const g = guess;
  const a = answer;

  const lines = [];
  lines.push(`- 字母命中：${charHitSummary(g, a, "en")}`);

  const lenDiff = g.length - a.length;
  const lenMsg =
    lenDiff === 0 ? "长度相同。" : lenDiff < 0 ? `你的词更短（少 ${-lenDiff} 个字母）。` : `你的词更长（多 ${lenDiff} 个字母）。`;
  lines.push(`- 长度：${g.length} vs ${a.length}（${lenMsg}）`);

  const firstOk = g[0] && a[0] && g[0] === a[0];
  const lastOk = g[g.length - 1] && a[a.length - 1] && g[g.length - 1] === a[a.length - 1];
  lines.push(`- 首字母：${firstOk ? "命中" : "未命中"}；尾字母：${lastOk ? "命中" : "未命中"}`);

  const posHit = positionalMatches(g, a);
  lines.push(`- 同位置命中：${posHit} 个`);

  const overlap = overlapCount(g, a);
  const overlapRatio = a.length ? Math.round((overlap / a.length) * 100) : 0;
  lines.push(`- 字母重叠：至少 ${overlap} 个（约覆盖答案的 ${overlapRatio}%）`);

  const dist = editDistance(g, a);
  lines.push(`- 编辑距离：${dist}（越小越接近）`);

  // "引导式"强化：越接近给越具体的提示
  const closeness = Math.max(0, 1 - dist / Math.max(1, a.length));
  if (attemptIndex >= 2 && closeness > 0.55) {
    const n = Math.min(2, a.length);
    lines.push(`- 进阶提示：答案包含的前 ${n} 个字母是 "${a.slice(0, n)}"`);
  } else if (attemptIndex >= 4 && closeness > 0.35) {
    lines.push(`- 进阶提示：答案的字母集合与你的猜测有明显重叠，建议围绕已重叠字母改动 1–2 处。`);
  } else {
    lines.push(`- 建议：优先调整长度，再尝试让首字母或尾字母对齐。`);
  }

  return lines.join("\n");
}

function storageKey(dateKey, mode) {
  const mk = modeKey(mode);
  return `ConnWords:v2:${dateKey}:${mk}`;
}

function settingsKey() {
  return "ConnWords:settings:v1";
}

function loadSettings() {
  const fallback = {
    semanticEnabled: true,
    apiBaseUrl: "",
    apiModel: "",
    apiKey: "",
    difficulty: "B1",
    language: "en",
    cnCategory: "word",
    cnDifficulty: "normal",
  };
  const raw = localStorage.getItem(settingsKey());
  if (!raw) return fallback;
  const parsed = safeJsonParse(raw, fallback);
  const language     = clampToAllowed(parsed?.language, LANGUAGES, fallback.language);
  const cnCategory   = clampToAllowed(parsed?.cnCategory, CN_CATEGORIES, fallback.cnCategory);
  const cnDifficulty = clampToAllowed(parsed?.cnDifficulty, CN_DIFFICULTIES, fallback.cnDifficulty);
  const difficulty   = EN_DIFFICULTIES.includes(parsed?.difficulty) ? parsed.difficulty : "B1";
  return {
    ...fallback,
    ...parsed,
    semanticEnabled: Boolean(parsed?.semanticEnabled),
    apiBaseUrl: String(parsed?.apiBaseUrl ?? fallback.apiBaseUrl).trim(),
    apiModel: String(parsed?.apiModel ?? fallback.apiModel).trim(),
    apiKey: String(parsed?.apiKey ?? "").trim(),
    difficulty,
    language,
    cnCategory,
    cnDifficulty,
  };
}

function saveSettings(settings) {
  localStorage.setItem(settingsKey(), JSON.stringify(settings));
}

function semanticHintCacheKey(dateKey, mode, answer, guess) {
  const mk = modeKey(mode);
  const h = fnv1a32(`${mk}|${dateKey}|${answer}|${guess}`);
  return `ConnWords:semanticHint:v2:${dateKey}:${mk}:${h}`;
}

function loadCachedSemanticHint(dateKey, mode, answer, guess) {
  const raw = localStorage.getItem(semanticHintCacheKey(dateKey, mode, answer, guess));
  if (!raw) return null;
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed.hint !== "string") return null;
  return parsed.hint;
}

function cacheSemanticHint(dateKey, mode, answer, guess, hint) {
  localStorage.setItem(
    semanticHintCacheKey(dateKey, mode, answer, guess),
    JSON.stringify({ hint, at: Date.now() })
  );
}

async function generateSemanticHintViaLLM({ guess, answer, attemptIndex, historyGuesses, settings, mode, onChunk }) {
  const useProxy = !settings.apiKey;
  const url = useProxy
    ? "/api/hint"
    : `${(settings.apiBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const model = settings.apiModel || "gpt-4o-mini";

  const m = normalizeMode(mode);
  const isEn = m.language === "en";

  const system = isEn
    ? "You are a hint generator for an English word-guessing game." +
      " Your task is to guide the player toward the correct answer using semantic and contextual clues." +
      "\nRules:" +
      "\n- Never reveal the answer or any consecutive letter sequence from it." +
      "\n- Do not give explicit identifiers (e.g. \"the answer is X\", \"it starts with X\", \"it rhymes with X\")." +
      "\n- Only provide semantic clues: category, usage context, collocations, domain, hypernym/hyponym relationships, connotation, antonym direction." +
      "\n- Keep hints to 1–3 short paragraphs; you may suggest 2–4 thematic directions without listing synonyms." +
      "\n- Escalate specificity with each attempt (more attempts = more specific, but never expose the answer)." +
      "\n- Respond in English."
    : (m.category === "idiom"
        ? "你是一个中文成语猜词游戏的提示生成器。你的任务是根据【用户猜测成语】与【正确答案成语】之间的语义关系生成提示，引导用户猜到正确答案。"
        : "你是一个中文词语猜词游戏的提示生成器。你的任务是根据【用户猜测词语】与【正确答案词语】之间的语义关系生成提示，引导用户猜到正确答案。") +
      "\n规则：" +
      "\n- 绝对不要直接透露正确答案或拼写（包括不输出任何连续字母/连续汉字片段）。" +
      "\n- 不要给出能唯一确定答案的明示（例如：\"答案是X\"、\"首字是X\"、\"包含某个特定连续片段\"、\"出自某篇文章/某句原文\"等）。" +
      "\n- 只提供语义层面的联系：类别、用途、场景、上下位关系、同域词、常见搭配、反义/近义的方向、情感色彩等。" +
      (m.category === "idiom"
        ? "\n- 成语提示侧重：含义方向、使用场景、语气色彩、结构特征（例如偏褒义/贬义、常用于形容人/事），但不要讲典故细节或原句出处。"
        : "\n- 词语提示侧重：常见语境、搭配、所属领域、对比概念，但不要罗列同义词清单。") +
      "\n- 提示用中文输出，1-3 段，尽量简洁；可以给 2-4 个\"可能方向\"引导词，但不要列出具体同义词清单把答案暴露出来。" +
      "\n- 难度随尝试次数递进：尝试越多提示越具体（仍不能泄露答案）。";

  const hitSummary = charHitSummary(guess, answer, isEn ? "en" : "cn");
  const user = isEn
    ? [
        `Player's guess: ${guess}`,
        `Correct answer: ${answer}`,
        `Letter match analysis: ${hitSummary}`,
        `Attempt number (0-based): ${attemptIndex}`,
        historyGuesses?.length ? `Previous guesses: ${historyGuesses.join(", ")}` : "",
        "Please give the next hint.",
      ].filter(Boolean).join("\n")
    : [
        `用户猜测词: ${guess}`,
        `正确答案词: ${answer}`,
        `字符命中分析: ${hitSummary}`,
        `第几次尝试(从0开始): ${attemptIndex}`,
        historyGuesses?.length ? `历史猜测: ${historyGuesses.join(", ")}` : "",
        "请给出下一条提示。",
      ].filter(Boolean).join("\n");
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.7,
  };

  const headers = { "Content-Type": "application/json" };
  if (!useProxy) headers.Authorization = `Bearer ${settings.apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let detail = text;
    try { detail = JSON.parse(text)?.error ?? text; } catch { /* raw text */ }
    throw new Error(`${resp.status}: ${detail}`.slice(0, 300));
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE lines arrive as "data: {...}\n\n"
    const lines = buffer.split("\n");
    buffer = lines.pop(); // hold back any incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) {
          accumulated += delta;
          onChunk?.(accumulated);
        }
      } catch { /* incomplete JSON chunk — skip */ }
    }
  }

  if (!accumulated.trim()) throw new Error("LLM empty response");
  return accumulated.trim();
}

function loadState(dateKey, mode) {
  try {
    const raw = localStorage.getItem(storageKey(dateKey, mode));
    if (!raw) return { dateKey, solved: false, history: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.dateKey !== dateKey) return { dateKey, solved: false, history: [] };
    if (!Array.isArray(parsed.history)) parsed.history = [];
    return parsed;
  } catch {
    return { dateKey, solved: false, history: [] };
  }
}

function saveState(state, mode) {
  localStorage.setItem(storageKey(state.dateKey, mode), JSON.stringify(state));
}

function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node;
}

async function boot() {
  const dateKeyEl = el("dateKey");
  const statusTextEl = el("statusText");
  const tryCountEl = el("tryCount");
  const hintBoxEl = el("hintBox");
  const historyListEl = el("historyList");
  const footerMsgEl = el("footerMsg");
  const guessForm = el("guessForm");
  const guessLabel = el("guessLabel");
  const guessInput = el("guessInput");
  const btnGuess = el("btnGuess");
  const btnReset = el("btnReset");
  const btnHelp = el("btnHelp");
  const btnSettings = el("btnSettings");
  const btnCloseHelp = el("btnCloseHelp");
  const helpDialog = el("helpDialog");
  const settingsDialog = el("settingsDialog");
  const semanticEnabled = el("semanticEnabled");
  const apiBaseUrl = el("apiBaseUrl");
  const apiModel = el("apiModel");
  const apiKey = el("apiKey");
  const btnSaveSettings = el("btnSaveSettings");
  const btnCloseSettings = el("btnCloseSettings");
  const tabEn = el("tabEn");
  const tabCn = el("tabCn");
  const enControls = el("enControls");
  const cnControls = el("cnControls");
  const diffLabel = el("diffLabel");
  const wordLenStat = el("wordLenStat");
  const wordLenValue = el("wordLenValue");
  const cnDiffRow = el("cnDiffRow");
  const btnCnWord = el("btnCnWord");
  const btnCnIdiom = el("btnCnIdiom");
  const btnCnDiffNormal = el("btnCnDiffNormal");
  const btnCnDiffHard = el("btnCnDiffHard");
  const diffBtns = {
    A1: el("btnDiffA1"),
    A2: el("btnDiffA2"),
    B1: el("btnDiffB1"),
    B2: el("btnDiffB2"),
    C1: el("btnDiffC1"),
    C2: el("btnDiffC2"),
  };
  const btnShare = el("btnShare");
  const btnYesterday = el("btnYesterday");
  const btnTodayAnswer = el("btnTodayAnswer");
  const yesterdayDialog = el("yesterdayDialog");
  const todayDialog = el("todayDialog");
  const yesterdayModeLabel = el("yesterdayModeLabel");
  const yesterdayAnswerEl = el("yesterdayAnswer");
  const todayModeLabel = el("todayModeLabel");
  const todayAnswerEl = el("todayAnswer");
  const btnRevealToday = el("btnRevealToday");
  const btnCloseYesterday = el("btnCloseYesterday");
  const btnCloseToday = el("btnCloseToday");

  let settings = loadSettings();
  let mode = normalizeMode({
    language: settings.language,
    category: settings.cnCategory,
    difficulty: settings.difficulty,
    cnDifficulty: settings.cnDifficulty,
  });
  let words = await loadLexicon(mode);

  function currentDateKey() {
    return dateKeyLocalYYYYMMDD(new Date());
  }

  function computeAnswer(dateKey) {
    return pickDailyWord(words, dateKey, `ConnWords:${modeKey(mode)}`);
  }

  function updateDiffButtons() {
    for (const [diff, btn] of Object.entries(diffBtns)) {
      btn.classList.toggle("diffBtnActive", diff === settings.difficulty);
    }
  }

  function updateModeUI() {
    const isEn = mode.language === "en";
    tabEn.classList.toggle("tabActive", isEn);
    tabCn.classList.toggle("tabActive", !isEn);
    tabEn.setAttribute("aria-selected", String(isEn));
    tabCn.setAttribute("aria-selected", String(!isEn));

    enControls.hidden = !isEn;
    cnControls.hidden = isEn;
    cnDiffRow.hidden = isEn;
    wordLenStat.hidden = isEn;

    if (isEn) {
      diffLabel.textContent = "CEFR 等级：";
      guessLabel.textContent = "输入英文单词";
      guessInput.inputMode = "latin";
      guessInput.placeholder = "例如: apple";
    } else {
      diffLabel.textContent = "题库类型：";
      guessLabel.textContent = mode.category === "idiom" ? "输入四字成语" : "输入中文词语";
      guessInput.inputMode = "text";
      guessInput.placeholder = mode.category === "idiom" ? "例如: 画蛇添足" : "例如: 春天";
    }

    btnCnWord.classList.toggle("diffBtnActive", mode.language === "cn" && mode.category === "word");
    btnCnIdiom.classList.toggle("diffBtnActive", mode.language === "cn" && mode.category === "idiom");
    btnCnDiffNormal.classList.toggle("diffBtnActive", mode.language === "cn" && mode.cnDifficulty === "normal");
    btnCnDiffHard.classList.toggle("diffBtnActive", mode.language === "cn" && mode.cnDifficulty === "hard");

    updateDiffButtons();
  }

  function generateHintCn(guess, answer, attemptIndex, category) {
    const g = guess;
    const a = answer;
    const gArr = Array.from(g);
    const aArr = Array.from(a);

    const lines = [];
    lines.push(`- 字符命中：${charHitSummary(g, a, "cn")}`);

    if (category !== "idiom") {
      const lenDiff = gArr.length - aArr.length;
      const lenMsg =
        lenDiff === 0 ? "长度相同。" : lenDiff < 0 ? `你的词更短（少 ${-lenDiff} 个字）。` : `你的词更长（多 ${lenDiff} 个字）。`;
      lines.push(`- 长度：${gArr.length} vs ${aArr.length}（${lenMsg}）`);
    } else {
      lines.push(`- 长度：${gArr.length} vs ${aArr.length}（成语固定 4 字）`);
    }

    const firstOk = gArr[0] && aArr[0] && gArr[0] === aArr[0];
    const lastOk = gArr[gArr.length - 1] && aArr[aArr.length - 1] && gArr[gArr.length - 1] === aArr[aArr.length - 1];
    lines.push(`- 首字：${firstOk ? "命中" : "未命中"}；尾字：${lastOk ? "命中" : "未命中"}`);

    const posHit = positionalMatches(g, a);
    lines.push(`- 同位置命中：${posHit} 个`);

    const overlap = overlapCount(g, a);
    const overlapRatio = aArr.length ? Math.round((overlap / aArr.length) * 100) : 0;
    lines.push(`- 字符重叠：至少 ${overlap} 个（约覆盖答案的 ${overlapRatio}%）`);

    const dist = editDistance(g, a);
    lines.push(`- 编辑距离：${dist}（越小越接近）`);

    const closeness = Math.max(0, 1 - dist / Math.max(1, aArr.length));
    if (attemptIndex >= 2 && closeness > 0.55) {
      const n = Math.min(2, aArr.length);
      lines.push(`- 进阶提示：答案的前 ${n} 个字是 "${aArr.slice(0, n).join("")}"`);
    } else if (attemptIndex >= 4 && closeness > 0.35) {
      lines.push(`- 进阶提示：你已经很接近了，建议围绕已命中的位置做 1–2 处替换。`);
    } else {
      lines.push(`- 建议：先让长度对齐，再尝试让首字或尾字对齐。`);
    }

    return lines.join("\n");
  }

  function openDialog(dlg) {
    dlg.showModal();
    dlg.classList.remove("dialogClosing");
    dlg.classList.add("dialogOpening");
    dlg.addEventListener("animationend", () => dlg.classList.remove("dialogOpening"), { once: true });
  }

  function closeDialog(dlg) {
    dlg.classList.add("dialogClosing");
    dlg.addEventListener("animationend", () => {
      dlg.classList.remove("dialogClosing");
      dlg.close();
    }, { once: true });
  }

  function animateHint(text) {
    hintBoxEl.textContent = text;
    hintBoxEl.classList.remove("hintReveal");
    void hintBoxEl.offsetWidth; // force reflow so animation restarts
    hintBoxEl.classList.add("hintReveal");
  }

  function solvedPraise(attempts) {
    if (attempts === 1) return "Incredible! First try! 🎯";
    if (attempts === 2) return "Outstanding! Got it in 2!";
    if (attempts <= 4) return "Well done! Great guessing!";
    if (attempts <= 6) return "Nice work! You got there!";
    if (attempts <= 10) return "Good job! Persistence pays off!";
    return "You got it! Well played!";
  }

  function render(state, answer) {
    dateKeyEl.textContent = state.dateKey;
    tryCountEl.textContent = String(state.history.length);
    wordLenValue.textContent = mode.language === "cn" ? String(Array.from(answer).length) + " 字" : "-";
    statusTextEl.textContent = state.solved ? "已猜中" : "未猜中";
    statusTextEl.style.color = state.solved ? "var(--ok)" : "rgba(255,255,255,.86)";

    historyListEl.innerHTML = "";
    for (let i = 0; i < state.history.length; i++) {
      const item = state.history[i];
      const li = document.createElement("li");
      li.className = i === state.history.length - 1 ? "historyItem historyItemNew" : "historyItem";

      const top = document.createElement("div");
      top.className = "historyTop";
      const guessSpan = document.createElement("span");
      guessSpan.className = "historyGuess";
      if (mode.language === "cn") {
        const scored = scoreGuessChars(item.guess, answer);
        Array.from(item.guess).forEach((ch, i) => {
          const s = document.createElement("span");
          s.textContent = ch;
          if (scored[i] === "green") s.className = "charGreen";
          else if (scored[i] === "yellow") s.className = "charYellow";
          guessSpan.appendChild(s);
        });
      } else {
        guessSpan.textContent = item.guess;
      }

      const badge = document.createElement("span");
      badge.className = `historyBadge ${item.correct ? "badgeOk" : "badgeBad"}`;
      badge.textContent = item.correct ? "正确" : "不对";

      top.appendChild(guessSpan);
      top.appendChild(badge);

      const hint = document.createElement("div");
      hint.className = "historyHint";
      hint.textContent = item.hint ?? "";

      li.appendChild(top);
      li.appendChild(hint);
      historyListEl.appendChild(li);
    }

    btnShare.hidden = false;

    if (state.solved) {
      animateHint(mode.language === "en"
        ? `${solvedPraise(state.history.length)}\nThe answer was: ${answer}\n\nCome back tomorrow for a new word.`
        : `你猜对了。\n答案是：${answer}\n\n明天再来会换一个新词。`);
      guessInput.disabled = true;
      btnGuess.disabled = true;
      footerMsgEl.textContent = "已保存进度到本地浏览器。";
    } else if (state.history.length === 0) {
      animateHint(mode.language === "en" ? "先输入一个单词试试。" : "先输入一个中文词语/成语试试。");
      guessInput.disabled = false;
      btnGuess.disabled = false;
      footerMsgEl.textContent =
        mode.language === "en"
          ? "提示：只接受英文 a-z 字母，会自动去掉空格/符号。"
          : "提示：只接受中文汉字，会自动去掉空格/符号。";
    } else {
      animateHint(state.history[state.history.length - 1].hint);
      guessInput.disabled = false;
      btnGuess.disabled = false;
      footerMsgEl.textContent = "继续输入你的下一次猜测。";
    }
  }

  function startOrLoad() {
    const dateKey = currentDateKey();
    const answer = computeAnswer(dateKey);
    const state = loadState(dateKey, mode);
    render(state, answer);
    return { dateKey, answer, state };
  }

  updateModeUI();
  let session = startOrLoad();

  function applySettingsToUI() {
    semanticEnabled.checked = Boolean(settings.semanticEnabled);
    apiBaseUrl.value = settings.apiBaseUrl || "";
    apiModel.value = settings.apiModel || "";
    apiKey.value = settings.apiKey ? settings.apiKey : "";
  }

  applySettingsToUI();

  // Difficulty buttons
  for (const [diff, btn] of Object.entries(diffBtns)) {
    btn.addEventListener("click", async () => {
      if (mode.language !== "en") return;
      if (settings.difficulty === diff) return;
      settings = { ...settings, difficulty: diff };
      saveSettings(settings);
      updateDiffButtons();
      mode = normalizeMode({ ...mode, difficulty: diff });
      words = await loadLexicon(mode);
      session = startOrLoad();
      footerMsgEl.textContent = btn.textContent + " mode on.";
    });
  }

  tabEn.addEventListener("click", async () => {
    if (mode.language === "en") return;
    settings = { ...settings, language: "en" };
    saveSettings(settings);
    mode = normalizeMode({ ...mode, language: "en" });
    words = await loadLexicon(mode);
    updateModeUI();
    session = startOrLoad();
  });

  tabCn.addEventListener("click", async () => {
    if (mode.language === "cn") return;
    settings = { ...settings, language: "cn" };
    saveSettings(settings);
    mode = normalizeMode({ ...mode, language: "cn", category: settings.cnCategory || "word", cnDifficulty: settings.cnDifficulty || "normal" });
    words = await loadLexicon(mode);
    updateModeUI();
    session = startOrLoad();
  });

  btnCnWord.addEventListener("click", async () => {
    if (mode.language !== "cn" || mode.category === "word") return;
    settings = { ...settings, cnCategory: "word" };
    saveSettings(settings);
    mode = normalizeMode({ ...mode, language: "cn", category: "word" });
    words = await loadLexicon(mode);
    updateModeUI();
    session = startOrLoad();
  });

  btnCnIdiom.addEventListener("click", async () => {
    if (mode.language !== "cn" || mode.category === "idiom") return;
    settings = { ...settings, cnCategory: "idiom" };
    saveSettings(settings);
    mode = normalizeMode({ ...mode, language: "cn", category: "idiom" });
    words = await loadLexicon(mode);
    updateModeUI();
    session = startOrLoad();
  });

  btnCnDiffNormal.addEventListener("click", async () => {
    if (mode.language !== "cn" || mode.cnDifficulty === "normal") return;
    settings = { ...settings, cnDifficulty: "normal" };
    saveSettings(settings);
    mode = normalizeMode({ ...mode, cnDifficulty: "normal" });
    words = await loadLexicon(mode);
    updateModeUI();
    session = startOrLoad();
  });

  btnCnDiffHard.addEventListener("click", async () => {
    if (mode.language !== "cn" || mode.cnDifficulty === "hard") return;
    settings = { ...settings, cnDifficulty: "hard" };
    saveSettings(settings);
    mode = normalizeMode({ ...mode, cnDifficulty: "hard" });
    words = await loadLexicon(mode);
    updateModeUI();
    session = startOrLoad();
  });

  guessForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const raw = guessInput.value;
    const guess = mode.language === "en" ? normalizeGuess(raw) : normalizeGuessCn(raw);
    guessInput.value = "";
    guessInput.focus();

    if (!guess) {
      footerMsgEl.textContent = mode.language === "en" ? "请输入英文单词（a-z）。" : "请输入中文汉字。";
      return;
    }
    if (mode.language === "en") {
      if (guess.length < 3) {
        footerMsgEl.textContent = "请至少输入 3 个字母。";
        return;
      }
    } else if (mode.category === "idiom") {
      if (Array.from(guess).length !== 4) {
        footerMsgEl.textContent = "成语模式：请输入 4 个汉字。";
        return;
      }
    } else {
      const n = Array.from(guess).length;
      if (n < 2) {
        footerMsgEl.textContent = "请至少输入 2 个汉字。";
        return;
      }
      if (n > 8) {
        footerMsgEl.textContent = "请最多输入 8 个汉字。";
        return;
      }
    }
    if (session.state.solved) return;

    const correct = guess === session.answer;
    const attemptIndex = session.state.history.length;
    const attemptsSoFar = session.state.history.length + 1;
    let hint = mode.language === "en" ? solvedPraise(attemptsSoFar) : "你猜对了。";
    if (!correct) {
      const cached = settings.semanticEnabled ? loadCachedSemanticHint(session.dateKey, mode, session.answer, guess) : null;
      if (cached) {
        hint = cached;
      } else if (settings.semanticEnabled) {
        hintBoxEl.classList.add("hintStreaming");

        const thinkingPhrases = mode.language === "en"
          ? ["Thinking", "Analyzing", "Considering", "Reflecting", "Processing", "Evaluating"]
          : ["正在思考", "分析中", "理解中", "考虑中", "评估中", "推断中"];
        let phraseIdx = 0;
        hintBoxEl.textContent = thinkingPhrases[0];
        const thinkingTimer = setInterval(() => {
          phraseIdx = (phraseIdx + 1) % thinkingPhrases.length;
          hintBoxEl.textContent = thinkingPhrases[phraseIdx];
        }, 750);

        try {
          const historyGuesses = session.state.history.map((h) => h.guess).slice(-10);
          hint = await generateSemanticHintViaLLM({
            guess,
            answer: session.answer,
            attemptIndex,
            historyGuesses,
            settings,
            mode,
            onChunk: (text) => {
              clearInterval(thinkingTimer);
              hintBoxEl.textContent = text;
            },
          });
          clearInterval(thinkingTimer);
          hintBoxEl.classList.remove("hintStreaming");
          cacheSemanticHint(session.dateKey, mode, session.answer, guess, hint);
        } catch (err) {
          clearInterval(thinkingTimer);
          hintBoxEl.classList.remove("hintStreaming");
          const reason = err?.message ? `（${err.message}）` : "";
          hint =
            `AI 提示失败，已回退到本地提示。${reason}\n\n` +
            (mode.language === "en"
              ? generateHint(guess, session.answer, attemptIndex)
              : generateHintCn(guess, session.answer, attemptIndex, mode.category));
        }
      } else {
        hint =
          mode.language === "en"
            ? generateHint(guess, session.answer, attemptIndex)
            : generateHintCn(guess, session.answer, attemptIndex, mode.category);
      }
    }

    session.state.history.push({ guess, correct, hint, at: Date.now() });
    if (correct) session.state.solved = true;
    saveState(session.state, mode);
    render(session.state, session.answer);
  });

  btnReset.addEventListener("click", () => {
    localStorage.removeItem(storageKey(session.dateKey, mode));
    session = startOrLoad();
  });

  btnHelp.addEventListener("click", () => {
    openDialog(helpDialog);
  });

  btnCloseHelp.addEventListener("click", () => {
    closeDialog(helpDialog);
  });

  btnSettings.addEventListener("click", () => {
    applySettingsToUI();
    openDialog(settingsDialog);
  });

  btnCloseSettings.addEventListener("click", () => {
    closeDialog(settingsDialog);
  });

  btnSaveSettings.addEventListener("click", () => {
    settings = {
      ...settings,
      semanticEnabled: Boolean(semanticEnabled.checked),
      apiBaseUrl: String(apiBaseUrl.value || "").trim(),
      apiModel: String(apiModel.value || "").trim(),
      apiKey: String(apiKey.value || "").trim(),
    };
    saveSettings(settings);
    closeDialog(settingsDialog);
    footerMsgEl.textContent = settings.semanticEnabled
      ? "已开启语义提示（优先调用接口）。"
      : "已关闭语义提示（使用本地提示）。";
  });

  el("btnToggleHistory").addEventListener("click", () => {
    const btn = el("btnToggleHistory");
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!expanded));

    if (expanded) {
      // Collapse: pin to current px height in one frame, then transition to 0
      historyListEl.style.height = historyListEl.scrollHeight + "px";
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          historyListEl.style.height = "0px";
          historyListEl.style.opacity = "0";
        });
      });
    } else {
      // Expand: transition from 0 to scrollHeight, then free to auto
      historyListEl.style.height = historyListEl.scrollHeight + "px";
      historyListEl.style.opacity = "1";
      const onHeightDone = (e) => {
        if (e.propertyName !== "height") return;
        historyListEl.style.height = "auto";
        historyListEl.removeEventListener("transitionend", onHeightDone);
      };
      historyListEl.addEventListener("transitionend", onHeightDone);
    }
  });

  btnShare.addEventListener("click", async () => {
    const n = session.state.history.length;
    const text = session.state.solved
      ? `我用${n}次就猜中了今天的词，你也来试试吧！\n${window.location.href}`
      : `我还没猜出来今天的词，要不你来试试？\n${window.location.href}`;
    try {
      await navigator.clipboard.writeText(text);
      const orig = btnShare.textContent;
      btnShare.textContent = "已复制！";
      setTimeout(() => { btnShare.textContent = orig; }, 1800);
    } catch {
      footerMsgEl.textContent = "复制失败，请手动复制：" + text;
    }
  });

  function modeLabelText() {
    const lang = mode.language === "en" ? "英文" : "中文";
    const cat  = mode.language === "cn" ? (mode.category === "idiom" ? " · 成语" : " · 词语") : "";
    const diff = mode.language === "en"
      ? ` · ${mode.difficulty}`
      : (mode.cnDifficulty === "hard" ? " · 困难" : " · 普通");
    return lang + cat + diff;
  }

  btnYesterday.addEventListener("click", () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const yesterdayKey = dateKeyLocalYYYYMMDD(d);
    const answer = pickDailyWord(words, yesterdayKey, `ConnWords:${modeKey(mode)}`);
    yesterdayModeLabel.textContent = modeLabelText() + " · " + yesterdayKey;
    yesterdayAnswerEl.textContent = answer;
    openDialog(yesterdayDialog);
  });

  btnCloseYesterday.addEventListener("click", () => {
    closeDialog(yesterdayDialog);
  });

  btnTodayAnswer.addEventListener("click", () => {
    todayModeLabel.textContent = modeLabelText() + " · " + session.dateKey;
    todayAnswerEl.hidden = true;
    btnRevealToday.hidden = false;
    openDialog(todayDialog);
  });

  btnRevealToday.addEventListener("click", () => {
    todayAnswerEl.textContent = session.answer;
    todayAnswerEl.hidden = false;
    btnRevealToday.hidden = true;
  });

  btnCloseToday.addEventListener("click", () => {
    closeDialog(todayDialog);
  });

  statusTextEl.textContent = "未猜中";
}

document.addEventListener("DOMContentLoaded", () => {
  boot().catch((err) => {
    const msg = String(err?.message ?? err);
    const status = document.getElementById("statusText");
    const hint = document.getElementById("hintBox");
    if (status) status.textContent = "加载失败";
    if (hint) {
      hint.textContent =
        "词库加载失败。\n\n你需要用本地服务器打开这个页面（不要直接双击打开）。\n推荐：在项目目录运行：\npython -m http.server 5173\n然后访问 http://localhost:5173\n\n错误信息：" +
        msg;
    }
  });
});

// Expose small API for debugging / future extension
window.ConnWordsDaily = {
  loadLexicon,
  dateKeyLocalYYYYMMDD,
  pickDailyWord,
  normalizeGuess,
  normalizeGuessCn,
  generateHint,
  generateSemanticHintViaLLM,
};
