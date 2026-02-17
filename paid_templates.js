// paid_templates.js

function safe(v) {
  return v ? String(v) : "未入力";
}

function buildPaidContent(answers = {}) {
  return `ここから先は有料。サラの“設計”パートよ💋
まずは素材を出しな。こっちは当てずっぽうで喋らない♡

・状況：${safe(answers.problem)}
・目的：${safe(answers.goal)}

【最初に1回だけ：呼び名セット（任意）】
スクショの理解が一気に安定するから、できたら入れて💋
※本名じゃなくてOK。未設定でも進める。

例：
相手→自分=先輩
自分→相手=Aちゃん

（未定なら「未設定」でOK。あとから「呼び名変更」でも変えられる）

次に送ってほしいもの（どれか1つ）：
1) 相手の返信本文（コピペ or スクショ）
2) 既読/未読の状況
3) まだ送ってないなら、どうしたいか1行

※ここからは具体までやる。だから先に材料ちょうだい💋`;
}

module.exports = { buildPaidContent };
