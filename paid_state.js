// paid_state.js
const PaidPhase = Object.freeze({
  UNKNOWN: "UNKNOWN",
  BEFORE_SEND: "BEFORE_SEND",     // まだ相手に送ってない（これから送る）
  WAITING_REPLY: "WAITING_REPLY", // 送った後、返信待ち（既読/未読含む）
  AFTER_REPLY: "AFTER_REPLY",     // 相手から返信が来て、その返しを作る
});

function norm(s) {
  return (s || "").trim();
}

function detectPhaseFromText(text) {
  const t = norm(text);

  // ① BEFORE_SEND（送る前・添削依頼・コピペ/スクショ/送っていい？）
  if (
    /(まだ送ってない|送ってない|送る前|未送信|これ送って|この文面|添削|直して|文章|文面|送っていい|コピペでいい|スクショでいい)/.test(t)
  ) {
    return PaidPhase.BEFORE_SEND;
  }

  // ② AFTER_REPLY（返信が来た/相手の返事の引用/相手の文がある）
  if (
    /(返信きた|返事きた|相手から|向こうから|って返ってきた|って来た|って言われた)/.test(t) ||
    /「[^」]{1,120}」/.test(t)
  ) {
    return PaidPhase.AFTER_REPLY;
  }

  // ③ WAITING_REPLY（既読/未読/無視/スルー/返事ない）
  if (
    /(既読|未読|既読無視|未読無視|スルー|無視|返事ない|返信ない|返ってこない|返って来ない|音沙汰ない)/.test(t)
  ) {
    return PaidPhase.WAITING_REPLY;
  }

  return PaidPhase.UNKNOWN;
}

/**
 * paid.phase を更新（answers の lastSender も加味）
 * - BEFORE_SEND が最優先（ユーザーが添削/送る前と言ってるならそれ）
 */
function updatePaidPhaseFromUserText(session, userText) {
  const t = norm(userText);
  const answers = session?.answers || {};
  const prev = session?.paid?.phase || PaidPhase.UNKNOWN;

  // テキストからの判定（BEFORE_SEND優先）
  const byText = detectPhaseFromText(t);
  if (byText !== PaidPhase.UNKNOWN) {
    session.paid.phase = byText;
    return session.paid.phase;
  }

  // 既知スロットから推定
  // lastSender が相手なら AFTER_REPLY、lastSender が自分なら WAITING_REPLY
  if (answers.lastSender === "相手") {
    session.paid.phase = PaidPhase.AFTER_REPLY;
    return session.paid.phase;
  }
  if (answers.lastSender === "自分") {
    session.paid.phase = PaidPhase.WAITING_REPLY;
    return session.paid.phase;
  }

  // 何も分からなければ前回を維持（UNKNOWNに落ちないように）
  session.paid.phase = prev;
  return session.paid.phase;
}

module.exports = {
  PaidPhase,
  updatePaidPhaseFromUserText,
};
