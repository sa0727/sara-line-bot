// stripe_routes.js
const Stripe = require("stripe");
const { query } = require("./db");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function nowMs() {
  return Date.now();
}

function isActiveUserRow(row) {
  if (!row) return false;
  const st = (row.subscription_status || "").toLowerCase();
  const okStatus = st === "active" || st === "trialing";
  const until = row.paid_until ? new Date(row.paid_until).getTime() : 0;
  return okStatus && until > nowMs();
}

async function getUser(lineUserId) {
  const r = await query(`select * from users where line_user_id=$1`, [lineUserId]);
  return r.rows[0] || null;
}

async function upsertUserPaid({
  lineUserId,
  stripeCustomerId,
  stripeSubscriptionId,
  status,
  currentPeriodEndUnix, // seconds
}) {
  const paidUntil = currentPeriodEndUnix ? new Date(currentPeriodEndUnix * 1000) : null;

  await query(
    `
    insert into users (line_user_id, stripe_customer_id, stripe_subscription_id, subscription_status, current_period_end, paid_until, updated_at)
    values ($1,$2,$3,$4,$5,$6,now())
    on conflict (line_user_id) do update set
      stripe_customer_id=excluded.stripe_customer_id,
      stripe_subscription_id=excluded.stripe_subscription_id,
      subscription_status=excluded.subscription_status,
      current_period_end=excluded.current_period_end,
      paid_until=excluded.paid_until,
      updated_at=now()
    `,
    [
      lineUserId,
      stripeCustomerId || null,
      stripeSubscriptionId || null,
      status || null,
      paidUntil || null,
      paidUntil || null,
    ]
  );
}

async function markUserUnpaidBySubscription(subId, status) {
  // subIdからユーザー特定して落とす
  const r = await query(`select line_user_id from users where stripe_subscription_id=$1`, [subId]);
  const row = r.rows[0];
  if (!row) return;

  await query(
    `
    update users
    set subscription_status=$2,
        paid_until=null,
        current_period_end=null,
        updated_at=now()
    where stripe_subscription_id=$1
    `,
    [subId, status || "canceled"]
  );
}

async function alreadyProcessed(eventId) {
  const r = await query(`select 1 from processed_events where event_id=$1`, [eventId]);
  return r.rowCount > 0;
}

async function markProcessed(eventId) {
  await query(`insert into processed_events(event_id) values($1) on conflict do nothing`, [eventId]);
}

function mountStripeRoutes(app) {
  // Checkout作成（サブスク）
  app.post("/stripe/checkout", app.jsonParser, async (req, res) => {
    try {
      const { lineUserId } = req.body || {};
      if (!lineUserId) return res.status(400).json({ ok: false, error: "missing lineUserId" });

      const existing = await getUser(lineUserId);
      if (isActiveUserRow(existing)) {
        return res.json({ ok: true, alreadyPaid: true });
      }

      const baseUrl = process.env.APP_BASE_URL; // https://sara-line-bot.onrender.com
      const priceId = process.env.STRIPE_PRICE_ID; // ¥980/月のPrice ID

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}/billing/success`,
        cancel_url: `${baseUrl}/billing/cancel`,
        client_reference_id: lineUserId,
        metadata: { lineUserId, plan: "sara_980_monthly" },
        // customer_creation: "always", // 任意：毎回customer作るなら
        allow_promotion_codes: false,
      });

      // paymentsログ（冪等のため）
      await query(
        `insert into payments(checkout_session_id,line_user_id,status) values($1,$2,$3)
         on conflict (checkout_session_id) do nothing`,
        [session.id, lineUserId, "created"]
      );

      res.json({ ok: true, url: session.url, checkoutSessionId: session.id });
    } catch (e) {
      console.error("[stripe/checkout] error", e);
      res.status(500).json({ ok: false, error: "checkout_failed" });
    }
  });

  // Webhook（raw body必須）
  app.post("/stripe/webhook", app.rawParser, async (req, res) => {
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("[stripe/webhook] signature verify failed", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (await alreadyProcessed(event.id)) {
        return res.status(200).json({ received: true, dedup: true });
      }

      // ここからイベント別に処理
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const lineUserId = session.client_reference_id || session.metadata?.lineUserId;
          if (!lineUserId) break;

          // subscriptionを取得してcurrent_period_endを確定させる
          const subId = session.subscription;
          const customerId = session.customer;

          const sub = await stripe.subscriptions.retrieve(subId);
          await upsertUserPaid({
            lineUserId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subId,
            status: sub.status,
            currentPeriodEndUnix: sub.current_period_end,
          });

          await query(
            `update payments set status=$2, stripe_subscription_id=$3 where checkout_session_id=$1`,
            [session.id, "paid", subId]
          );

          break;
        }

        case "customer.subscription.updated": {
          const sub = event.data.object;
          const subId = sub.id;

          // subId→lineUserId は users から引く（最小実装）
          const r = await query(`select line_user_id from users where stripe_subscription_id=$1`, [subId]);
          const row = r.rows[0];
          if (!row) break;

          await upsertUserPaid({
            lineUserId: row.line_user_id,
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: subId,
            status: sub.status,
            currentPeriodEndUnix: sub.current_period_end,
          });
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object;
          await markUserUnpaidBySubscription(sub.id, sub.status || "canceled");
          break;
        }

        // 任意（強化するなら）
        // case "invoice.payment_failed":
        // case "invoice.payment_succeeded":
        //   ...

        default:
          break;
      }

      await markProcessed(event.id);
      res.status(200).json({ received: true });
    } catch (e) {
      console.error("[stripe/webhook] handler error", e);
      res.status(500).json({ received: true, error: "handler_failed" });
    }
  });

  // 見た目用（確定はWebhook）
  app.get("/billing/success", (req, res) => {
    res.status(200).send("決済ありがとう💋 LINEに戻って続けな。");
  });
  app.get("/billing/cancel", (req, res) => {
    res.status(200).send("キャンセルOK💋 続けたいならLINEで『▶ 続きを見る（有料）』って送って。");
  });
}

module.exports = { mountStripeRoutes, getUser, isActiveUserRow };
