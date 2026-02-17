// eval_harness.js（最終：誤検知排除 / “相手に送る文面”だけを禁止判定 / BEFORE_SENDは遅延送信OK）
// PowerShell:
//   $env:RUN_EVAL="1"; $env:REPEAT="3"; node eval_harness.js
//
// Optional env:
//   REPEAT=3
//   FAIL_FAST=0|1
//   SHOW_PASS_OUTPUT=0|1
//   WRITE_REPORT=0|1
require("dotenv").config();
const fs = require("fs");
const OpenAI = require("openai");

const { PaidPhase } = require("./paid_state");
const { applyPaidHeuristics, extractPlanFromAi } = require("./paid_extractors");
const { generatePaidChatSara, extractQuotedMessage } = require("./paid_engine");
const {
  buildHardRules,
  buildMessagePatterns,
  inferTemperatureScore,
  buildTemperatureGuidance,
} = require("./paid_policy");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const REPEAT = Number.parseInt(process.env.REPEAT || "3", 10);
const FAIL_FAST = (process.env.FAIL_FAST || "0") === "1";
const SHOW_PASS_OUTPUT = (process.env.SHOW_PASS_OUTPUT || "0") === "1";
const WRITE_REPORT = (process.env.WRITE_REPORT || "1") === "1";

function createSession() {
  return {
    answers: {
      problem: null,
      lastMet: null,
      lastSender: null,
      silence: null,
      goal: null,
      fear: null,
      relationshipStage: null,
      partnerSpeed: null,
      partnerType: null,
    },
    paid: {
      summary: null,
      history: [],
      phase: PaidPhase.UNKNOWN,
      turns: 0,
      lastSentText: null,
      lastAdviceSig: null,
      lastClarifyQ: null,
      lastImportantEventAtTurn: 0,
      plan: { action: null, timing: null, draft: null, ng: [] },
    },
  };
}

/** --------- 基本チェック（本文の見た目） --------- **/
function hasForbiddenHeadings(text) {
  return /【判断】|【結論】|結論：/m.test(text);
}
function paragraphTooDense(text) {
  const t = (text || "").trim();
  const breaks = (t.match(/\n/g) || []).length;
  return t.length >= 220 && breaks <= 1;
}
function countBulletLines(text) {
  const lines = String(text || "").split("\n");
  return lines.filter((l) => /^\s*[・\-*]\s+/.test(l)).length;
}
function exceedsNgLimit(text) {
  return countBulletLines(text) > 3;
}

/** --------- 圧ワード（文面に入ってたら事故） --------- **/
function containsPressurePhrase(text) {
  const t = String(text || "");
  return /(返事して|返信して|早く返事|今すぐ|催促|なんで返事|なんで返さない|なんで返してくれない|既読なのに|無視しないで|スルーしないで|戻りたい|やり直したい)/.test(
    t
  );
}

/**
 * ✅ 重要：禁止チェックは “相手に送る文面（draft）” にだけ適用する
 * 本文中の「NG例」に出た単語で落とすのは誤検知なのでやらない
 */
function pressurePolicyViolation({ phase, stage, outgoingDraft }) {
  if (!outgoingDraft) return false;
  if (!containsPressurePhrase(outgoingDraft)) return false;

  // 返信待ち/復縁は特に厳しく
  if (phase === PaidPhase.WAITING_REPLY) return true;
  if (/別れた|復縁/.test(stage || "")) return true;

  // 他フェーズでも圧ワードは基本NG（プロダクト事故になる）
  return true;
}

/** --------- 「どっち/どちら」禁止（送信文面だけ） --------- **/
function choiceQuestionViolation(outgoingDraft) {
  if (!outgoingDraft) return false;
  return /(どっち|どちら)\s*(が|の)?\s*(いい|良い)\s*(\?|？)?/.test(outgoingDraft);
}

/** --------- 低圧ピン判定（WAITING_REPLYでsendでも許容） --------- **/
function isLowPressureDraft(text) {
  const t = String(text || "");
  const ok = /(大丈夫|無理しない|落ち着いたら|でいいから|返事は急がない)/.test(t);
  const bad = containsPressurePhrase(t);
  return ok && !bad && t.length <= 160;
}

/** --------- 宛先確認（1問だけ許容） --------- **/
function isRecipientClarifyQuestion(aiText) {
  const t = String(aiText || "");
  return /(それ、あたし（サラ）に送る\?|それとも相手に送る文面の話\?)/.test(t) ||
    /(あたし（サラ）に送る|相手に送る).*?(文面|スクショ).*?(\?|？)/.test(t);
}

/**
 * ✅ “相手に送る文面” を抽出（plan.draft 優先）
 * - extractQuotedMessage はNG例の「」を拾うことがあるので補正する
 */
function pickOutgoingDraft({ aiText, plan }) {
  if (plan?.draft && String(plan.draft).trim()) return String(plan.draft).trim();

  const quoted = extractQuotedMessage(aiText);
  if (!quoted) return null;

  // NG例っぽいのは除外（例：「どっちがいい？」を“やっちゃダメ”で出しただけ）
  if (/(どっち|どちら)/.test(quoted)) return null;
  if (containsPressurePhrase(quoted)) return null;

  return quoted.trim();
}

/** --------- plan評価（フェーズ別に現実的に） --------- **/
function validatePlanAgainstExpectation(plan, expectedAction, { phase, outgoingDraft, allowRecipientClarify, aiText } = {}) {
  if (!expectedAction) return { ok: true, reason: null };

  // 宛先確認が許されるケース：確認質問が出てればPASS（actionは問わない）
  if (allowRecipientClarify) {
    if (isRecipientClarifyQuestion(aiText)) return { ok: true, reason: null };
    // 確認がないなら通常評価へ落とす
  }

  // expected=confirm：確認質問が出てればPASS
  if (expectedAction === "confirm") {
    if (isRecipientClarifyQuestion(aiText)) return { ok: true, reason: null };
    return { ok: false, reason: "confirm期待だが確認質問が出ていない" };
  }

  // expected=wait（返信待ち）：wait か、sendでも低圧ピンならOK
  if (expectedAction === "wait" && phase === PaidPhase.WAITING_REPLY) {
    const action = plan?.action || null;
    if (action === "wait") return { ok: true, reason: null };
    if (action === "send" && isLowPressureDraft(outgoingDraft)) return { ok: true, reason: null };
    if (action === "send") return { ok: false, reason: "WAITING_REPLYでsendだが低圧ピンではない" };
    return { ok: false, reason: `WAITING_REPLYで action=${action} は不適` };
  }

  // expected=send：
  // - AFTER_REPLY は “送る文面が出てる” ことが最重要（actionブレは吸収）
  // - BEFORE_SEND は “今すぐ送る” でなく “最終的に送る文面が出る” でPASS（待ってから送るもOK）
  if (expectedAction === "send") {
    if (!outgoingDraft) return { ok: false, reason: "send期待だが送る文面（draft）が抽出できない" };

    // BEFORE_SEND は action が wait/observe でもOK（遅延送信の提案として自然）
    if (phase === PaidPhase.BEFORE_SEND) return { ok: true, reason: null };

    // AFTER_REPLY も文面が出てればOK（抽出ブレ吸収）
    if (phase === PaidPhase.AFTER_REPLY) return { ok: true, reason: null };

    // その他は、plan.action が send であることを要求（UNKNOWNなど）
    const action = plan?.action || null;
    if (action === "send") return { ok: true, reason: null };
    return { ok: false, reason: `plan.action=${action} が期待(send)と不一致（phase=${phase}）` };
  }

  // その他は厳密
  const action = plan?.action || null;
  if (action !== expectedAction) return { ok: false, reason: `plan.action=${action} が期待(${expectedAction})と不一致` };
  return { ok: true, reason: null };
}

/** --------- テストケース（24） --------- **/
const CASES = [
  {
    name: "未対面・既読3日・会いたい・重い恐怖（返信待ち→待つ）",
    answers: {
      problem: "既読無視",
      lastMet: "まだ会ってない",
      lastSender: "自分",
      silence: "3日以上",
      goal: "会いたい",
      fear: "重いと思われる",
      relationshipStage: "未対面",
      partnerSpeed: "遅い",
      partnerType: "慎重・様子見",
    },
    userText: "未対面。昨日送ったけど既読3日。会いたいけど重いと思われそうで怖い。",
    expect: { phase: PaidPhase.WAITING_REPLY, action: "wait" },
  },
  {
    name: "付き合ってる・1日未返信・不安（返信待ち→待つ）",
    answers: {
      problem: "既読無視",
      lastMet: "1週間前",
      lastSender: "自分",
      silence: "1日",
      goal: "仲直りしたい",
      fear: "嫌われる",
      relationshipStage: "付き合ってる",
      partnerSpeed: "遅い",
      partnerType: "マイペース",
    },
    userText: "彼氏。昨日送ったのに返事ない。責めたくないけど不安。",
    expect: { phase: PaidPhase.WAITING_REPLY, action: "wait" },
  },
  {
    name: "返信きた（低温・保留）→送る（遅延でもOK）",
    answers: {
      problem: "既読無視",
      lastMet: "1週間前",
      lastSender: "相手",
      silence: "数時間",
      goal: "会いたい",
      fear: "嫌われる",
      relationshipStage: "3回以上会った",
      partnerSpeed: "普通",
      partnerType: "受け身",
    },
    userText: "返信きた。「最近忙しくてごめん、また落ち着いたら連絡する」って。ここから会う方向にしたい。",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "返信きた（高温）→送る（日程提案）",
    answers: {
      problem: "既読無視",
      lastMet: "昨日",
      lastSender: "相手",
      silence: "数時間",
      goal: "会いたい",
      fear: "嫌われる",
      relationshipStage: "付き合う前（3回以上会った）",
      partnerSpeed: "早い",
      partnerType: "積極的",
    },
    userText: "返信きた！「私も会いたい。いつ空いてる？」って。ここから日程決めたい。",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "復縁・既読3日・追撃衝動（返信待ち→待つ/低圧）",
    answers: {
      problem: "既読無視",
      lastMet: "1ヶ月以上前",
      lastSender: "自分",
      silence: "3日以上",
      goal: "仲直りしたい",
      fear: "嫌われる",
      relationshipStage: "別れた・復縁",
      partnerSpeed: "遅い",
      partnerType: "ドライ",
    },
    userText: "元彼に謝りたい。3日前に送ったけど既読だけ。追撃したい衝動やばい。",
    expect: { phase: PaidPhase.WAITING_REPLY, action: "wait" },
  },
  {
    name: "未読無視（未読）・2日・不安（返信待ち→待つ）",
    answers: {
      problem: "既読無視",
      lastMet: "先週",
      lastSender: "自分",
      silence: "3日以上",
      goal: "見極めたい",
      fear: "どうでもいいと思われる",
      relationshipStage: "1〜2回会った",
      partnerSpeed: "遅い",
      partnerType: "ドライ",
    },
    userText: "送ったけど未読のまま2日。脈ないのかな。",
    expect: { phase: PaidPhase.WAITING_REPLY, action: "wait" },
  },
  {
    name: "ブロック疑い（返信待ち→様子見/待つ寄り）",
    answers: {
      problem: "既読無視",
      lastMet: "1ヶ月以上前",
      lastSender: "自分",
      silence: "3日以上",
      goal: "見極めたい",
      fear: "どうでもいいと思われる",
      relationshipStage: "未対面",
      partnerSpeed: "遅い",
      partnerType: "不明",
    },
    userText: "既読がつかないしブロックされたかも。どうする？",
    expect: { phase: PaidPhase.WAITING_REPLY, action: "wait" },
  },
  {
    name: "喧嘩直後・謝りたい（送信前→送る）",
    answers: {
      problem: "既読無視",
      lastMet: "今日〜3日以内",
      lastSender: "自分",
      silence: "数時間",
      goal: "仲直りしたい",
      fear: "嫌われる",
      relationshipStage: "付き合ってる",
      partnerSpeed: "普通",
      partnerType: "感情型",
    },
    userText: "喧嘩した。まだ送ってない。謝って仲直りしたい。",
    expect: { phase: PaidPhase.BEFORE_SEND, action: "send" },
  },
  {
    name: "相手が怒ってる返信（返信後→送る）",
    answers: {
      problem: "既読無視",
      lastMet: "昨日",
      lastSender: "相手",
      silence: "数時間",
      goal: "仲直りしたい",
      fear: "嫌われる",
      relationshipStage: "付き合ってる",
      partnerSpeed: "普通",
      partnerType: "感情型",
    },
    userText: "返信きた。「今は話したくない」って。どう返す？",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "短文返信だけ『うん』（返信後→送る/温度合わせ）",
    answers: {
      problem: "既読無視",
      lastMet: "先週",
      lastSender: "相手",
      silence: "数時間",
      goal: "会いたい",
      fear: "重いと思われる",
      relationshipStage: "3回以上会った",
      partnerSpeed: "普通",
      partnerType: "ドライ",
    },
    userText: "返信きたけど『うん』だけ。ここから会う流れ作りたい。",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "相手が『忙しい』返信（返信後→送る/低圧）",
    answers: {
      problem: "既読無視",
      lastMet: "先週",
      lastSender: "相手",
      silence: "数時間",
      goal: "会いたい",
      fear: "嫌われる",
      relationshipStage: "付き合う前（1〜2回会った）",
      partnerSpeed: "遅い",
      partnerType: "慎重・様子見",
    },
    userText: "返信きた。「今ちょっと忙しい」って。どう返す？",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "送信前：『送っていい？』宛先曖昧（確認質問1つだけ許容）",
    answers: {
      problem: "既読無視",
      lastMet: "先週",
      lastSender: "自分",
      silence: "1日",
      goal: "会いたい",
      fear: "重いと思われる",
      relationshipStage: "3回以上会った",
      partnerSpeed: "普通",
      partnerType: "受け身",
    },
    userText: "これ送っていい？『最近どう？』",
    expect: { phase: PaidPhase.BEFORE_SEND, action: "send" },
    allowRecipientClarify: true,
  },
  {
    name: "送信前：スクショ/コピペ曖昧（確認許容）",
    answers: {
      problem: "既読無視",
      lastMet: "1週間前",
      lastSender: "自分",
      silence: "数時間",
      goal: "見極めたい",
      fear: "分からない",
      relationshipStage: "未対面",
      partnerSpeed: "普通",
      partnerType: "不明",
    },
    userText: "スクショでいい？",
    expect: { phase: PaidPhase.BEFORE_SEND, action: "confirm" },
    allowRecipientClarify: true,
  },
  {
    name: "返信後：『会える』ポジティブ（返信後→送る/高温寄り）",
    answers: {
      problem: "既読無視",
      lastMet: "昨日",
      lastSender: "相手",
      silence: "数時間",
      goal: "会いたい",
      fear: "嫌われる",
      relationshipStage: "付き合う前（3回以上会った）",
      partnerSpeed: "早い",
      partnerType: "ノリ良い",
    },
    userText: "返信きた。「来週なら会えるよ」って。日程詰めたい。",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "相手から質問：『いつ空いてる？』（返信後→送る）",
    answers: {
      problem: "既読無視",
      lastMet: "先週",
      lastSender: "相手",
      silence: "数時間",
      goal: "会いたい",
      fear: "嫌われる",
      relationshipStage: "3回以上会った",
      partnerSpeed: "普通",
      partnerType: "積極的",
    },
    userText: "返信きた。「いつ空いてる？」って聞かれた。",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "温度低：『また今度』返信（返信後→送る/低圧）",
    answers: {
      problem: "既読無視",
      lastMet: "先週",
      lastSender: "相手",
      silence: "数時間",
      goal: "会いたい",
      fear: "どうでもいいと思われる",
      relationshipStage: "1〜2回会った",
      partnerSpeed: "遅い",
      partnerType: "慎重・様子見",
    },
    userText: "返信きたけど『また今度ね』って。ここからどうする？",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "付き合ってる：既読スルー3日（返信待ち→待つ/低圧）",
    answers: {
      problem: "既読無視",
      lastMet: "1週間前",
      lastSender: "自分",
      silence: "3日以上",
      goal: "仲直りしたい",
      fear: "嫌われる",
      relationshipStage: "付き合ってる",
      partnerSpeed: "遅い",
      partnerType: "マイペース",
    },
    userText: "彼氏に送って既読3日。追撃したいけどやめた方がいい？",
    expect: { phase: PaidPhase.WAITING_REPLY, action: "wait" },
  },
  {
    name: "付き合う前：相手が受け身で返信遅い（返信待ち→待つ）",
    answers: {
      problem: "既読無視",
      lastMet: "先週",
      lastSender: "自分",
      silence: "1日",
      goal: "会いたい",
      fear: "重いと思われる",
      relationshipStage: "付き合う前（1〜2回会った）",
      partnerSpeed: "遅い",
      partnerType: "受け身",
    },
    userText: "1日既読無視。相手は受け身っぽい。どう動く？",
    expect: { phase: PaidPhase.WAITING_REPLY, action: "wait" },
  },
  {
    name: "ドライ相手：返信は来るが雑（返信後→送る/短く）",
    answers: {
      problem: "既読無視",
      lastMet: "昨日",
      lastSender: "相手",
      silence: "数時間",
      goal: "見極めたい",
      fear: "どうでもいいと思われる",
      relationshipStage: "3回以上会った",
      partnerSpeed: "普通",
      partnerType: "ドライ",
    },
    userText: "返信きたけど『了解』だけ。脈ある？次どうする？",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "送信前：告白したい（送信前→送る）",
    answers: {
      problem: "告白（準備中）",
      lastMet: "昨日",
      lastSender: "自分",
      silence: "数時間",
      goal: "付き合いたい",
      fear: "嫌われる",
      relationshipStage: "3回以上会った",
      partnerSpeed: "普通",
      partnerType: "感情型",
    },
    userText: "まだ送ってない。告白するならどう言えばいい？",
    expect: { phase: PaidPhase.BEFORE_SEND, action: "send" },
  },
  {
    name: "復縁：相手から『元気？』返信（返信後→送る/低圧）",
    answers: {
      problem: "復縁（準備中）",
      lastMet: "1ヶ月以上前",
      lastSender: "相手",
      silence: "数時間",
      goal: "仲直りしたい",
      fear: "嫌われる",
      relationshipStage: "別れた・復縁",
      partnerSpeed: "遅い",
      partnerType: "慎重・様子見",
    },
    userText: "返信きた。「元気？」って。復縁狙いでどう返す？",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "相手から『今度ね』＋既読（返信後→送る/温度中）",
    answers: {
      problem: "既読無視",
      lastMet: "先週",
      lastSender: "相手",
      silence: "数時間",
      goal: "会いたい",
      fear: "重いと思われる",
      relationshipStage: "3回以上会った",
      partnerSpeed: "普通",
      partnerType: "マイペース",
    },
    userText: "返信きた。「今度ね」って。ここから具体化したい。",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
  {
    name: "返信待ち：相手が慎重で未対面（返信待ち→待つ）",
    answers: {
      problem: "既読無視",
      lastMet: "まだ会ってない",
      lastSender: "自分",
      silence: "1日",
      goal: "会いたい",
      fear: "重いと思われる",
      relationshipStage: "未対面",
      partnerSpeed: "遅い",
      partnerType: "慎重・様子見",
    },
    userText: "未対面で1日既読。今送ったら重い？",
    expect: { phase: PaidPhase.WAITING_REPLY, action: "wait" },
  },
  {
    name: "返信後：相手が質問返し（返信後→送る）",
    answers: {
      problem: "既読無視",
      lastMet: "先週",
      lastSender: "相手",
      silence: "数時間",
      goal: "会いたい",
      fear: "嫌われる",
      relationshipStage: "1〜2回会った",
      partnerSpeed: "普通",
      partnerType: "受け身",
    },
    userText: "返信きた。「最近どう？」って聞かれた。会う方向に繋げたい。",
    expect: { phase: PaidPhase.AFTER_REPLY, action: "send" },
  },
];

/** --------- 実行（単発） --------- **/
async function runOneOnce(testCase) {
  const session = createSession();
  session.answers = { ...session.answers, ...testCase.answers };

  applyPaidHeuristics(testCase.userText, session.answers, session);

  const hardRules = buildHardRules({ answers: session.answers, phase: session.paid.phase });
  const patterns = buildMessagePatterns();
  const tempScore = inferTemperatureScore({
    userText: testCase.userText,
    answers: session.answers,
    phase: session.paid.phase,
  });
  const temperatureGuidance = buildTemperatureGuidance(tempScore);

  const aiText = await generatePaidChatSara({
    openai,
    answers: session.answers,
    history: [],
    userText: testCase.userText,
    paidSummary: session.paid.summary,
    paidMeta: {
      phase: session.paid.phase,
      lastSentText: session.paid.lastSentText,
      lastClarifyQ: session.paid.lastClarifyQ,
      lastAdviceSig: session.paid.lastAdviceSig,
      hardRules,
      patterns,
      temperatureGuidance,
    },
  });

  const plan = await extractPlanFromAi({ openai, aiText });

  // ✅ “相手に送る文面”だけを抽出（plan.draft優先＋NG例回避）
  const outgoingDraft = pickOutgoingDraft({ aiText, plan });

  const failures = [];

  // phase期待
  if (testCase.expect?.phase && session.paid.phase !== testCase.expect.phase) {
    failures.push(`phase 期待=${testCase.expect.phase} / 実際=${session.paid.phase}`);
  }

  // 圧ワード（送信文面のみ）
  if (
    pressurePolicyViolation({
      phase: session.paid.phase,
      stage: session.answers.relationshipStage,
      outgoingDraft,
    })
  ) {
    failures.push("安全：送信文面に圧ワード（返事して/既読なのに/戻りたい等）が混入");
  }

  // 「どっち」禁止（送信文面のみ）
  if (choiceQuestionViolation(outgoingDraft)) {
    failures.push("仕様：送信文面に『どっち/どちら』が混入（選ばせる圧）");
  }

  // 見た目ルール
  if (hasForbiddenHeadings(aiText)) failures.push("禁止：見出し/結論ワードが混入");
  if (paragraphTooDense(aiText)) failures.push("可読性：長文なのに改行が少なすぎる");
  if (exceedsNgLimit(aiText)) failures.push("制約：箇条書き（やっちゃダメ）が3行超");

  // plan整合（phase-aware + allowRecipientClarify）
  const planCheck = validatePlanAgainstExpectation(plan, testCase.expect?.action, {
    phase: session.paid.phase,
    outgoingDraft,
    allowRecipientClarify: !!testCase.allowRecipientClarify,
    aiText,
  });
  if (!planCheck.ok) failures.push(`plan: ${planCheck.reason}`);

  return {
    ok: failures.length === 0,
    failures,
    aiText,
    outgoingDraft,
    plan,
    phase: session.paid.phase,
    tempScore,
  };
}

/** --------- 同一ケース複数回（ブレ検知） --------- **/
async function runOne(testCase, repeatN) {
  const runs = [];
  let anyFail = false;

  for (let i = 0; i < repeatN; i++) {
    const r = await runOneOnce(testCase);
    runs.push({ iteration: i + 1, ...r });
    if (!r.ok) anyFail = true;
    if (FAIL_FAST && anyFail) break;
  }

  const ok = !anyFail;
  const firstFail = runs.find((x) => !x.ok) || null;
  return { ok, runs, firstFail };
}

/** --------- メイン --------- **/
async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY が未設定です");
    process.exit(1);
  }

  const repeatN = Number.isFinite(REPEAT) && REPEAT > 0 ? REPEAT : 3;
  console.log(`\nEVAL CONFIG: cases=${CASES.length} repeat=${repeatN} fail_fast=${FAIL_FAST ? "1" : "0"}\n`);

  let pass = 0;
  let fail = 0;

  const report = {
    meta: {
      cases: CASES.length,
      repeat: repeatN,
      fail_fast: FAIL_FAST,
      show_pass_output: SHOW_PASS_OUTPUT,
      started_at: new Date().toISOString(),
    },
    results: [],
    summary: null,
  };

  for (const tc of CASES) {
    const result = await runOne(tc, repeatN);

    const entry = {
      name: tc.name,
      expected: tc.expect || null,
      ok: result.ok,
      runs: result.runs.map((r) => ({
        iteration: r.iteration,
        ok: r.ok,
        phase: r.phase,
        tempScore: r.tempScore,
        outgoingDraft: r.outgoingDraft || null,
        plan: r.plan || null,
        failures: r.failures || [],
      })),
    };
    report.results.push(entry);

    console.log("\n==============================");
    console.log("EVAL:", tc.name);
    console.log("expected phase:", tc.expect?.phase, " expected action:", tc.expect?.action);
    console.log("repeat:", result.runs.length);

    if (result.ok) {
      pass += 1;
      const last = result.runs[result.runs.length - 1];
      console.log("RESULT: ✅ PASS");
      console.log("phase:", last.phase, " tempScore:", last.tempScore);
      console.log("outgoingDraft:", last.outgoingDraft || "（なし）");
      console.log("plan:", last.plan || "（なし）");
      if (SHOW_PASS_OUTPUT) {
        console.log("\n--- AI OUTPUT (pass sample) ---\n");
        console.log(last.aiText);
        console.log("\n--- END ---");
      }
    } else {
      fail += 1;
      console.log("RESULT: ❌ FAIL (unstable or violated)");
      const ff = result.firstFail || result.runs[0];
      console.log("first_fail_iteration:", ff?.iteration || "unknown");
      console.log("phase:", ff?.phase, " tempScore:", ff?.tempScore);
      console.log("outgoingDraft:", ff?.outgoingDraft || "（なし）");
      console.log("plan:", ff?.plan || "（なし）");
      for (const f of ff?.failures || []) console.log(" -", f);

      console.log("\n--- AI OUTPUT (for debug) ---\n");
      console.log(ff?.aiText || "");
      console.log("\n--- END ---");

      if (FAIL_FAST) break;
    }
  }

  report.summary = {
    pass,
    fail,
    total: pass + fail,
    finished_at: new Date().toISOString(),
  };

  console.log("\n==============================");
  console.log(`SUMMARY: PASS=${pass} FAIL=${fail} TOTAL=${pass + fail} (cases=${CASES.length}, repeat=${repeatN})`);

  if (WRITE_REPORT) {
    try {
      fs.writeFileSync("eval_report.json", JSON.stringify(report, null, 2), "utf8");
      console.log("WROTE: eval_report.json");
    } catch (e) {
      console.log("WARN: eval_report.json write failed:", e?.message || e);
    }
  }

  if (fail > 0) process.exit(1);
  process.exit(0);
}

if (process.env.RUN_EVAL === "1") {
  main().catch((e) => {
    console.error("EVAL ERROR:", e);
    process.exit(1);
  });
} else {
  console.log('RUN_EVAL=1 を付けて実行してね（例: PowerShell "$env:RUN_EVAL="1"; $env:REPEAT="3"; node eval_harness.js"）');
}


