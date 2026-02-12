function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickPhase({ silence }) {
  const isLongSilence = silence === "3日以上";
  return isLongSilence
    ? "相手の優先度が下がってる可能性が出てる局面"
    : "温度差が出始めてる局面";
}

function jitterPercent(base, range = 7) {
  const delta = Math.floor(Math.random() * (range * 2 + 1)) - range;
  return Math.max(35, Math.min(65, base + delta));
}

function pickHypotheses({ silence }) {
  if (silence === "3日以上") {
    const p1 = jitterPercent(50);
    return [`余裕がなくて放置（${p1}%）`, `距離を取りたい（${100 - p1}%）`];
  }
  const p1 = jitterPercent(55);
  return [`忙しくて後回し（${p1}%）`, `様子見で距離調整（${100 - p1}%）`];
}

function fearLine(fear) {
  const map = {
    嫌われる:
      "嫌われたくなくて動くとね、逆に“重さ”が出やすいの。今日はそこ注意よ。",
    "他に好きな人がいる":
      "疑い始めると、言葉がトゲっぽくなるの。証拠がない間は詰めない。",
    "どうでもいいと思われる":
      "確認したくなる気持ちは分かる。でも確認ほど、相手の熱を冷ます行動ないの。",
    "重いと思われる":
      "重いかどうかは気持ちじゃなくて“頻度”。ここからは頻度設計ね。",
    分からない: "分からない時こそ、感情じゃなくて基準で動くのが正解。",
  };
  return map[fear] || "怖さの正体が分かるだけで、行動はズレにくくなるわ。";
}

function buildFreeAnalysis(answers) {
  const { lastMet, silence, goal, fear } = answers;

  const phase = pickPhase({ silence });
  const [hypothesis1, hypothesis2] = pickHypotheses({ silence });

  const intro = pick([
    "うん、分かった。まず落ち着きなさい。",
    "大丈夫。今の話で全体はちゃんと見えた。",
    "把握よ。ここで焦ると損する。",
  ]);

  const outro = pick([
    "ここから先は、一手で空気が変わるところ。",
    "次が分かれ道よ。自己判断は一番外しやすい。",
    "ここ、感情で動くと失敗する人が多いの。",
  ]);

  return (
    `${intro}\n\n` +
    `【状況整理】\n` +
    `・既読無視：${silence}\n` +
    `・最後に会った：${lastMet}\n` +
    `・あなたのゴール：${goal}\n` +
    `・いちばん怖いもの：${fear}\n\n` +
    `【今のフェーズ】\n` +
    `・${phase}\n` +
    `（ここで雑に動く人が、一番こじらせるの）\n\n` +
    `【あなたの心の正体】\n` +
    `怖いのって結局、「${fear}」でしょ。\n` +
    `それ、普通よ。\n` +
    `${fearLine(fear)}\n\n` +
    `【相手心理の仮説】\n` +
    `① ${hypothesis1}\n` +
    `② ${hypothesis2}\n\n` +
    `【ここからが分かれ道】\n` +
    `「待つ」か「送る」か。\n` +
    `送るなら“一文の設計”が9割。\n` +
    `一文字ズレると、相手は引く。\n\n` +
    `${outro}\n` +
    `続けるなら、あたしが\n` +
    `今のあんた専用に、\n` +
    `✅ 送る/待つの判断\n` +
    `✅ ベストな時間\n` +
    `✅ たった1通の文面（1〜2文）\n` +
    `ここまで出してあげる💋`
  );
}

module.exports = {
  buildFreeAnalysis,
};
