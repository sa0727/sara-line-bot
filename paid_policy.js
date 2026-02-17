// paid_policy.js
const { PaidPhase } = require("./paid_state");

function safe(v, fallback = "不明") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s ? s : fallback;
}

/**
 * ハードルール：モデルに「絶対やる/絶対やらない」を強制する文字列
 * ※ paid_engine 側が「機械見出し禁止」なので、ここも短い命令文で縛る
 *
 * 重要：
 * - WAITING_REPLY で “既読無視が続いている” 場合に、日程打診を繰り返さないための制約を追加
 * - ignoreStreak は session.paid.ignoreStreak（paid_state.js 側で明示判定時のみ加算）を想定
 */
function buildHardRules({ answers, phase, userText = "", session = null }) {
  const stage = safe(answers?.relationshipStage, "");
  const isReunion = /別れた|復縁/.test(stage);

  const t = (userText || "").trim();

  // 低温ワード（AFTER_REPLYでも“押すな”判定）
  const isLowEnergyReply = /忙しい|余裕ない|疲れた|しんどい|無理|難しい|ごめん|また今度|落ち着いたら/.test(t);

  // ★既読無視の連続（WAITING_REPLY が明示で続いた回数）
  const ignoreStreak = Number(session?.paid?.ignoreStreak || 0);
  const isWaiting = phase === PaidPhase.WAITING_REPLY;

  // ★日程打診っぽい要求語（繰り返し禁止の対象）
  const forbidDateAsk = isWaiting && ignoreStreak >= 1;

  const base = [
    // 不確かな話題の断言禁止
    '一般知識/ゲーム/時事など、確信がない内容は断言しない。分からない時は「分からない」と言い、確認質問は1つだけ。',

    // 選ばせる圧を排除
    '相手に送る文面に「どっち」「どちら」を入れない。',

    // ★重要：日程提案ルールは「提案する場合」に限定（常時強制しない）
    '日程提案をする場合は「○日か○日あたり空いてたら嬉しい。都合いい日あれば教えて」型に寄せる。',

    // 曖昧質問の処理
    'ユーザーの「送っていい？/コピペでいい？/スクショでいい？」は、宛先（サラ宛か相手宛）を文脈で判定する。',
    '判定できない時だけ、最初に確認質問を1つだけする（それ以外で選ばせない）。',

    // 詰め・圧・地雷
    '相手を責める、詰める、コントロールする誘導はしない。',
    '相手に送る文面で「なんで返事くれないの？」「既読なのに」系は禁止。',
    '文面は必ず「」で、1〜2文。長文は禁止。',
    '提案は基本1案。例外でも2案まで。',
  ];

  const reunionExtra = isReunion
    ? [
        '復縁は圧ワード厳禁：「戻りたい」「やり直したい」「会って話したい」直球は今は避ける。',
        '謝罪を盛らない。重さを出さず、入口（軽い接触）を作る。',
      ]
    : [];

  const waitingRules =
    phase === PaidPhase.WAITING_REPLY
      ? [
          '返信待ちは基本「追撃しない」。送るなら低圧の1通だけ。',
          '催促・連投・追い質問は禁止。質問は1つまで。',

          ...(forbidDateAsk
            ? [
                '既読無視が続いている局面では、会う日程を聞く/日程調整の提案をしない。',
                'この局面で送るなら「受け止め＋逃げ道」の1通だけ。要求（会う・日程・返信の催促）を入れない。',
                '送らない判断も正解。送らない場合は「いつまで待つか」だけ具体に示す。',
              ]
            : []),
        ]
      : [];

  const beforeSendRules =
    phase === PaidPhase.BEFORE_SEND
      ? [
          '送信前は「これを送る」の1案で決める。確認で止めすぎない。',
          'タイミングも必ず指定する（今日/明日/2日後＋時間帯）。',
        ]
      : [];

  const afterReplyRules =
    phase === PaidPhase.AFTER_REPLY
      ? [
          '返信後は最初に「受け止め」を1文入れる（相手の内容に反応）。その後に前進の一手。',
          '返しの文面を必ず「」で作る（1〜2文）。',
          '相手が「忙しい/余裕ない/疲れた/ごめん」系なら、日程を詰めず、逃げ道のある低圧返しにする。',
          ...(isLowEnergyReply ? ['この局面では日程押し・詰めはしない。'] : []),
        ]
      : [];

  const otherRules =
    phase !== PaidPhase.WAITING_REPLY && phase !== PaidPhase.BEFORE_SEND && phase !== PaidPhase.AFTER_REPLY
      ? ['迷ったら低圧。短く、具体、逃げ道。']
      : [];

  return [...base, ...reunionExtra, ...waitingRules, ...beforeSendRules, ...afterReplyRules, ...otherRules].join("\n");
}

function buildMessagePatterns() {
  return [
    '受け止め（要求ゼロ）例：「了解。忙しそうなら無理しないで。落ち着いたらで大丈夫だよ」',
    '受け止め（超短）例：「大丈夫。落ち着いたらでいいよ」',
    '共有（要求ゼロ）例：「今日これ見てちょっと笑った。落ち着いたら話そ」',
    '低温返信への返し例：「了解、今は無理しないで。落ち着いたらまた話そ」',
    '日程提案（使う場合）：「○日か○日あたり空いてたら嬉しい。都合いい日あれば教えて」',
    '謝罪例（言い訳なし）：「昨日は言い方きつくてごめんね。落ち着いたらまた話せたら嬉しい」',
  ].join("\n");
}

function inferTemperatureScore({ userText, answers, phase, session = null }) {
  const t = (userText || "").trim();
  const ignoreStreak = Number(session?.paid?.ignoreStreak || 0);

  if (phase === PaidPhase.WAITING_REPLY && ignoreStreak >= 1) return 0;
  if (/忙しい|余裕ない|疲れた|しんどい|無理|難しい|ごめん|また今度|落ち着いたら/.test(t)) return 0;
  if (/会いたい|会える|行きたい|楽しみ|会おう/.test(t)) return 1;
  if (phase === PaidPhase.AFTER_REPLY) return 0;

  return 0;
}

function buildTemperatureGuidance(score) {
  if (score >= 1) {
    return [
      "テンションは明るめでOK。でも圧は上げない。",
      "短く、具体に。質問は1つまで。",
      "長文・詰め・催促はしない。",
    ].join("\n");
  }

  return [
    "圧を下げて、具体を上げる。短く、軽く、逃げ道。",
    "追撃しない。確認で詰めない。",
    "送るなら低圧の1通だけ。質問は1つまで。",
  ].join("\n");
}

module.exports = {
  buildHardRules,
  buildMessagePatterns,
  inferTemperatureScore,
  buildTemperatureGuidance,
};


