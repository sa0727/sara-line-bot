function decideStrategy({ silence, lastSender }) {
  const isLongSilence = silence === "3日以上";
  const youSentLast = lastSender === "自分";

  const shouldWait = isLongSilence && youSentLast;

  const decision = shouldWait
    ? "結論：今は“追撃しない”。主導権を戻す局面。"
    : "結論：送ってOK。ただし“短く・一回で・具体”が条件。";

  const timing = shouldWait
    ? "まずは48時間は何もしない。送るなら“2日後の夜19〜21時”に1通だけ。"
    : "送るなら“今日の夜19〜21時”に1通だけ。";

  return { shouldWait, decision, timing };
}

function buildInviteByGoal(goal) {
  if (goal === "会いたい") return "落ち着いたらご飯でも行こ";
  if (goal === "仲直りしたい") return "落ち着いたら少し話せる？";
  if (goal === "付き合いたい") return "今度ゆっくり会えない？";
  return "最近どう？落ち着いたら少し話そ";
}

function buildDrafts({ goal }) {
  const baseInvite = buildInviteByGoal(goal);

  return [
    `【軽め】\n「最近どう？${baseInvite}」`,
    `【標準】\n「忙しかったらごめんね。${baseInvite}」`,
    `【しっかり】\n「返信がないのが心配だった。責めたいわけじゃないよ。落ち着いたら${baseInvite}」`,
  ];
}

function buildPaidContent(answers) {
  const { silence, goal, fear } = answers;

  // ※無料自由入力では lastSender を取ってないので、暫定で自分扱い
  const lastSender = answers.lastSender || "自分";

  const { decision, timing } = decideStrategy({ silence, lastSender });
  const drafts = buildDrafts({ goal });

  const ng = ["追いLINE（追加で送る）", "詰問（なんで返信くれないの？系）", "長文で感情を全部吐く"];

  return (
    `ここから先、有料パートよ💋\n` +
    `（※いまは課金ゲート未実装。中身を先に固めてる段階）\n\n` +
    `【あなたの不安の扱い方】\n` +
    `怖いのが「${fear}」なら、やりがちなのが“確認LINE”。\n` +
    `でもそれ、今の局面だと逆効果になりやすい。\n\n` +
    `【判断】\n${decision}\n\n` +
    `【タイミング】\n${timing}\n\n` +
    `【送る文面（1通だけ）】\n${drafts.join("\n\n")}\n\n` +
    `【NG行動3つ】\n${ng.map((x, i) => `${i + 1}️⃣ ${x}`).join("\n")}\n\n` +
    `送ったら「結果」って送って。\n` +
    `（次工程で、結果フロー→返信生成まで繋げるわ）`
  );
}

module.exports = {
  buildPaidContent,
  decideStrategy,
};
