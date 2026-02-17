// paid_state.js
const PaidPhase = Object.freeze({
  UNKNOWN: "UNKNOWN",
  BEFORE_SEND: "BEFORE_SEND",
  WAITING_REPLY: "WAITING_REPLY",
  AFTER_REPLY: "AFTER_REPLY",
});

/**
 * 会話モード（目的）
 */
const PaidMode = Object.freeze({
  CHAT: "CHAT",
  EMOTION: "EMOTION",
  ANALYSIS: "ANALYSIS",
  STRATEGY: "STRATEGY",
});

function norm(s) {
  return (s || "").trim();
}

function normalizeLastSender(v) {
  const t = norm(v);
  if (!t) return null;
  if (/(ユーザー|自分|私|わたし)/.test(t)) return "自分";
  if (/(相手|彼女|彼)/.test(t)) return "相手";
  if (t === "自分" || t === "相手") return t;
  return null;
}

/* ===============================
   PHASE判定（優先順位が重要）
   - AFTER_REPLY（引用/相手の返答）最優先
   - WAITING_REPLY（既読/未読/返事なし/追撃局面）を BEFORE_SEND より優先
   - BEFORE_SEND（未送信/添削/文面作成）
=================================*/

function detectPhaseFromText(text) {
  const t = norm(text);
  if (!t) return PaidPhase.UNKNOWN;

  // 1) AFTER_REPLY（相手の返答が来た局面）
  if (
    /(返信きた|返事きた|相手から|向こうから|って返ってきた|って来た|って言われた)/.test(t) ||
    /「[^」]{1,140}」/.test(t) // 引用があるなら相手の発言として扱う（あなたの設計通り）
  ) {
    return PaidPhase.AFTER_REPLY;
  }

  // 2) WAITING_REPLY（既読/未読/無視/返事なし）
  // ※「送っていい？」が混ざっても、既読無視なら追撃局面＝WAITING_REPLYが優先
  if (
    /(既読|未読|既読無視|未読無視|スルー|無視|返事ない|返信ない|音沙汰ない|返ってこない|返って来ない)/.test(t)
  ) {
    return PaidPhase.WAITING_REPLY;
  }

  // 3) BEFORE_SEND（送る前の添削・文面作成）
  if (
    /(まだ送ってない|送る前|未送信|この文面|添削|直して|文章|文面|送っていい|送る？|送って大丈夫|コピペ|スクショ|例文)/.test(t)
  ) {
    return PaidPhase.BEFORE_SEND;
  }

  return PaidPhase.UNKNOWN;
}

/* ===============================
   MODE判定（重要）
   優先順位：
   1) EMOTION（最優先）
   2) STRATEGY（行動/文面/タイミング/追撃/送っていい）
   3) ANALYSIS（読み解き）
   4) CHAT
=================================*/

function detectModeFromText(text) {
  const t = norm(text);
  if (!t) return PaidMode.CHAT;

  // 1) 感情（最優先）
  if (/(つらい|辛い|しんどい|苦しい|泣きそう|不安|限界|もうだめ|無理)/.test(t)) {
    return PaidMode.EMOTION;
  }

  // 2) STRATEGY（行動確定/文面/タイミング/追撃）
  // 「送っていい？」「追撃したい」を確実に拾う
  if (
    /(送っていい|送る？|送って大丈夫|送信していい|送信して大丈夫|どう送る|いつ送る|何時に送る|タイミング|間あけ|何日あけ|追撃|追いLINE|追いライン|文面|文章|例文|添削|直して|コピペ|この文面|この文章|これで送る|返す？|どう返す)/.test(
      t
    )
  ) {
    return PaidMode.STRATEGY;
  }

  // 文面引用がある → STRATEGY（添削・返答案のいずれも戦略寄り）
  if (/「[^」]{1,140}」/.test(t)) {
    return PaidMode.STRATEGY;
  }

  // 3) ANALYSIS（読み解き）
  if (/(嫌われ|脈|心理|どう思われ|何考え|なぜ|理由|可能性|温度感|本音)/.test(t)) {
    return PaidMode.ANALYSIS;
  }

  // 恋愛ワード含む → ANALYSISに寄せる（強み）
  if (/(既読|未読|返信|復縁|告白|喧嘩|彼|彼女|元カレ|元カノ|好き)/.test(t)) {
    return PaidMode.ANALYSIS;
  }

  return PaidMode.CHAT;
}

/**
 * mode 更新（安全運用）
 * - 超短文の「え？」「なんで？」等で暴れない
 * - ただし STRATEGY/EMOTION が明示されたら短文でも切り替える
 */
// NOTE: 旧実装との互換のため、呼び出し形を2通り許可する
// 1) updatePaidModeFromUserText(session, userText)
// 2) updatePaidModeFromUserText(userText, currentMode, lastMode)
function updatePaidModeFromUserText(a, b, c) {
  // (session, userText)
  if (a && typeof a === "object" && typeof b === "string") {
    const session = a;
    const userText = b;

    if (!session.paid) session.paid = {};

    const prev = session.paid.mode || PaidMode.CHAT;
    const t = norm(userText);
    const detected = detectModeFromText(t);

    // 超短文で、かつCHAT判定ならprev維持
    if (t.length <= 4 && detected === PaidMode.CHAT) {
      session.paid.mode = prev;
      return session.paid.mode;
    }

    session.paid.mode = detected || prev;
    return session.paid.mode;
  }

  // (userText, currentMode, lastMode)
  const userText = typeof a === "string" ? a : "";
  const prev = (c != null ? c : b) || PaidMode.CHAT;
  const t = norm(userText);
  const detected = detectModeFromText(t);
  if (t.length <= 4 && detected === PaidMode.CHAT) return prev;
  return detected || prev;
}

/* ===============================
   IGNORE管理
=================================*/

function updateIgnoreStreak(session, nextPhase, phaseByText) {
  if (!session.paid) session.paid = {};
  if (session.paid.ignoreStreak == null) session.paid.ignoreStreak = 0;

  if (nextPhase === PaidPhase.AFTER_REPLY) {
    session.paid.ignoreStreak = 0;
    return;
  }

  // WAITING_REPLY を「テキストで明示判定できた時だけ」増やす（設計通り）
  if (nextPhase === PaidPhase.WAITING_REPLY && phaseByText === PaidPhase.WAITING_REPLY) {
    session.paid.ignoreStreak = Number(session.paid.ignoreStreak || 0) + 1;
  }
}

// NOTE: 旧実装との互換のため、呼び出し形を2通り許可する
// 1) updatePaidPhaseFromUserText(session, userText)
// 2) updatePaidPhaseFromUserText(userText, prevPhase)
function updatePaidPhaseFromUserText(a, b) {
  // (session, userText)
  if (a && typeof a === "object" && typeof b === "string") {
    const session = a;
    const userText = b;
    const t = norm(userText);
    const answers = session?.answers || {};
    const prev = session?.paid?.phase || PaidPhase.UNKNOWN;

    if (!session.paid) session.paid = {};
    if (session.paid.ignoreStreak == null) session.paid.ignoreStreak = 0;

    const normalized = normalizeLastSender(answers.lastSender);
    if (normalized) answers.lastSender = normalized;

    const byText = detectPhaseFromText(t);

    if (byText !== PaidPhase.UNKNOWN) {
      session.paid.phase = byText;
      updateIgnoreStreak(session, session.paid.phase, byText);
      return session.paid.phase;
    }

    // メタ質問等で壊さない：prev維持
    if (prev && prev !== PaidPhase.UNKNOWN) {
      session.paid.phase = prev;
      return session.paid.phase;
    }

    // prevもUNKNOWNで lastSender="相手" のときだけ AFTER_REPLY 推定
    if (answers.lastSender === "相手") {
      session.paid.phase = PaidPhase.AFTER_REPLY;
      return session.paid.phase;
    }

    session.paid.phase = PaidPhase.UNKNOWN;
    return session.paid.phase;
  }

  // (userText, prevPhase)
  const userText = typeof a === "string" ? a : "";
  const prevPhase = typeof b === "string" ? b : PaidPhase.UNKNOWN;
  const t = norm(userText);
  const byText = detectPhaseFromText(t);
  if (byText !== PaidPhase.UNKNOWN) return byText;
  if (prevPhase && prevPhase !== PaidPhase.UNKNOWN) return prevPhase;
  return PaidPhase.UNKNOWN;
}

function adviceSignature(phase, quotedText, shortFacts) {
  const p = phase || "UNKNOWN";
  const q = (quotedText || "").slice(0, 80);
  const f = (shortFacts || "").slice(0, 120);
  return `${p}::${q}::${f}`;
}

module.exports = {
  PaidPhase,
  PaidMode,
  detectModeFromText,
  updatePaidModeFromUserText,
  updatePaidPhaseFromUserText,
  adviceSignature,
};


