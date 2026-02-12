function norm(s) {
  return (s || "").trim();
}

/**
 * ---- 既存スロット ----
 */

function extractLastMet(text) {
  const t = norm(text);

  if (/会ってない|まだ会っていない|未対面|まだ会ってない/.test(t)) return "まだ会ってない";

  if (/今日|きょう|さっき|さきほど/.test(t)) return "今日〜3日以内";
  if (/昨日|きのう|一昨日|おととい|2日前|３日前|3日前/.test(t)) return "今日〜3日以内";

  if (/先週|1週間|一週間|7日/.test(t)) return "1週間前";

  if (/1ヶ月|一ヶ月|１か月|ひと月|数週間|2週間|３週間|3週間|先月/.test(t)) return "1ヶ月以上前";

  return null;
}

function extractSilence(text) {
  const t = norm(text);

  if (/数分|数十分|数時間|さっき|数じかん/.test(t)) return "数時間";
  if (/1日|一日|24時間|昨日から|今日まで/.test(t)) return "1日";
  if (/2日|二日|3日|三日|4日|四日|5日|一週間|先週|数日/.test(t)) return "3日以上";

  return null;
}

function extractGoal(text) {
  const t = norm(text);

  if (/会いたい|会う|ご飯|ごはん|デート|遊びたい/.test(t)) return "会いたい";
  if (/仲直り|謝りたい|元に戻りたい|喧嘩|けんか/.test(t)) return "仲直りしたい";
  if (/付き合いたい|告白|彼氏|彼女|正式/.test(t)) return "付き合いたい";
  if (/見極め|脈|どう思われ|様子見|判断/.test(t)) return "見極めたい";

  return null;
}

function extractFear(text) {
  const t = norm(text);

  if (/嫌われ|嫌がら|引かれ|切られ/.test(t)) return "嫌われる";
  if (/他に|好きな人|別の人|浮気|女いる|男いる/.test(t)) return "他に好きな人がいる";
  if (/どうでも|興味ない|冷めた|飽きた|めんど/.test(t)) return "どうでもいいと思われる";
  if (/重い|面倒|めんどくさい|圧|しつこい/.test(t)) return "重いと思われる";
  if (/分からない|わからない|不明/.test(t)) return "分からない";

  return null;
}

/**
 * ---- 追加スロット（精度強化用）----
 * relationshipStage / partnerSpeed / partnerType
 */

/**
 * 関係性ステージ
 * - 未対面
 * - 初デート前
 * - 1〜2回会った
 * - 3回以上会った
 * - 付き合ってる
 * - 別れた・復縁したい
 */
function extractRelationshipStage(text) {
  const t = norm(text);

  // 別れ・復縁が最優先（強シグナル）
  if (/元カレ|元彼|元カノ|元彼女|別れた|破局|復縁|よりを戻/.test(t)) {
    return "別れた・復縁したい";
  }

  // 交際中
  if (/付き合ってる|彼氏|彼女|恋人|交際中|同棲|婚約/.test(t)) {
    return "付き合ってる";
  }

  // 未対面
  if (/未対面|会ったことない|まだ会ってない|まだ会っていない|会えてない/.test(t)) {
    return "未対面";
  }

  // 初デート前（これから会う）
  if (/今度会う|初デート|はじめて会う|初めて会う|会う約束|会う予定|来週会う|来月会う/.test(t)) {
    return "初デート前";
  }

  // 会った回数
  if (/1回会った|一回会った|一度会った|会ったのは1回|会ったのは一回/.test(t)) {
    return "1〜2回会った";
  }
  if (/2回会った|二回会った|会ったのは2回|会ったのは二回/.test(t)) {
    return "1〜2回会った";
  }
  if (/3回|三回|4回|四回|5回|五回|何回か|何度か|何回も|何度も|複数回/.test(t)) {
    return "3回以上会った";
  }

  return null;
}

/**
 * 相手のペース（返信/距離感の体感）
 * - 早い
 * - 普通
 * - 遅い
 * - 波がある
 */
function extractPartnerSpeed(text) {
  const t = norm(text);

  // ムラ系
  if (/ムラ|波|日による|気分|たまに|急に|返す時と返さない時/.test(t)) {
    return "波がある";
  }

  // 早い
  if (/即レス|すぐ返|秒で返|早い|爆速|レス早|返信早/.test(t)) {
    return "早い";
  }

  // 遅い
  if (/遅い|返ってこない|返信ない|既読無視|未読無視|放置|2日|二日|3日|三日|数日/.test(t)) {
    return "遅い";
  }

  // 普通（半日〜1日くらい）
  if (/半日|1日|一日|夜に返|仕事終わりに返|翌日/.test(t)) {
    return "普通";
  }

  return null;
}

/**
 * 相手タイプ（ざっくり）
 * - 慎重・様子見
 * - マイペース
 * - 受け身
 * - 積極的
 * - ドライ
 */
function extractPartnerType(text) {
  const t = norm(text);

  // 積極的
  if (/積極|グイグイ|誘ってくる|連絡してくる|追ってくる|好きって言う|会おう会おう/.test(t)) {
    return "積極的";
  }

  // 受け身
  if (/受け身|自分からは|誘わない|聞かないと|言わない|こちらから|待ち姿勢/.test(t)) {
    return "受け身";
  }

  // 慎重・様子見
  if (/慎重|様子見|警戒|見極め|ゆっくり|急がない|まだ分からない|タイミング/.test(t)) {
    return "慎重・様子見";
  }

  // ドライ
  if (/ドライ|淡白|そっけない|塩|クール|事務的|必要最低限/.test(t)) {
    return "ドライ";
  }

  // マイペース
  if (/マイペース|自由|気分屋|自分のペース|予定優先|忙しい人|仕事人間/.test(t)) {
    return "マイペース";
  }

  return null;
}

function applyFreeNLU(text, answers) {
  const updates = {};

  // ---- 既存 ----
  if (!answers.lastMet) {
    const v = extractLastMet(text);
    if (v) updates.lastMet = v;
  }

  if (!answers.silence) {
    const v = extractSilence(text);
    if (v) updates.silence = v;
  }

  if (!answers.goal) {
    const v = extractGoal(text);
    if (v) updates.goal = v;
  }

  if (!answers.fear) {
    const v = extractFear(text);
    if (v) updates.fear = v;
  }

  // ---- 追加：拾えるなら拾う（未入力の場合のみ）----
  if (!answers.relationshipStage) {
    const v = extractRelationshipStage(text);
    if (v) updates.relationshipStage = v;
  }

  if (!answers.partnerSpeed) {
    const v = extractPartnerSpeed(text);
    if (v) updates.partnerSpeed = v;
  }

  if (!answers.partnerType) {
    const v = extractPartnerType(text);
    if (v) updates.partnerType = v;
  }

  return updates;
}

function nextMissingQuestion(answers) {
  // 既存4つを優先
  if (!answers.lastMet) {
    return "まずここ。\n最後に会ったのはいつ？（会ってない／先週／1ヶ月以上前）";
  }
  if (!answers.silence) {
    return "次。\n既読無視はどれくらい？（数時間／1日／3日以上）";
  }
  if (!answers.goal) {
    return "で、ゴールは？（会いたい／仲直り／付き合いたい／見極めたい）";
  }
  if (!answers.fear) {
    return "最後。\nいちばん怖いのはどれ？（嫌われる／他にいる／どうでもいい／重い／分からない）";
  }

  // 追加3つ（精度強化）
  if (!answers.relationshipStage) {
    return "あと1つだけ、関係性を教えて。\n今どの段階？（未対面／初デート前／1〜2回会った／3回以上会った／付き合ってる／別れた・復縁）";
  }
  if (!answers.partnerSpeed) {
    return "相手のペース感ってどれ？\n（早い／普通／遅い／波がある）";
  }
  if (!answers.partnerType) {
    return "相手のタイプ、近いのはどれ？\n（慎重・様子見／マイペース／受け身／積極的／ドライ）";
  }

  return null;
}

module.exports = {
  applyFreeNLU,
  nextMissingQuestion,
};
