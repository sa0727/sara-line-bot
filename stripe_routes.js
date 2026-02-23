// stripe_routes.js

console.log("🔥 STRIPE ROUTES VERSION 2026-02-24-B");

const Stripe = require("stripe");
const { query } = require("./db");

// 明示しておくと挙動が安定（任意だが推奨）
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

function nowMs() {
  return Date.now();
}

function toLowerSafe(s) {
  return (s || "").toString().toLowerCase();
}

function toId(maybeIdOrObj) {
  if (!maybeIdOrObj) return null;
  if (typeof maybeIdOrObj === "string") return maybeIdOrObj;
  if (typeof maybeIdOrObj === "object" && typeof maybeIdOrObj.id === "string") return maybeIdOrObj.id;
  return null;
}

function isActiveUserRow(row) {
  if (!row) return false;
  const st = toLowerSafe(row.subscription_status);
  const okStatus = st === "active" || st === "trialing";
  const until = row.paid_until ? new Date(row.paid_until).getTime() : 0;
  return okStatus && until > nowMs();
}

async function getUser(lineUserId) {
  const r = await query(`select * from users where line_user_id=$1 limit 1`, [lineUserId]);
  return r.rows[0] || null;
}

/**
 * ✅ Unix秒をそのまま受け取り、DB側で to_timestamp() する
 *  - users.current_period_end / paid_until の型ブレ（timestamp vs bigint）地雷を回避
 */
async function upsertUserPaid({
  lineUserId,
  stripeCustomerId,
  stripeSubscriptionId,
  status,
  currentPeriodEndUnix, // seconds (number)
}) {
  await query(
    `
    insert into users (
      line_user_id,
      stripe_customer_id,
      stripe_subscription_id,
      subscription_status,
      current_period_end,
      paid_until,
      updated_at
    )
    values (
      $1,$2,$3,$4,
      case when $5 is null then null else to_timestamp($5) end,
      case when $5 is null then null else to_timestamp($5) end,
      now()
    )
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
      status || "inactive",
      currentPeriodEndUnix ?? null, // ← Unix seconds
    ]
  );
}

async function markUserUnpaidBySubscription(subId, status) {
  const r = await query(`select line_user_id from users where stripe_subscription_id=$1 limit 1`, [subId]);
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
  await query(
    `insert into processed_events(event_id) values($1) on conflict (event_id) do nothing`,
    [eventId]
  );
}

/**
 * ✅ 順序ズレ対策：
 *  - subscription_id で見つからない場合、customer_id でも探す
 */
async function findLineUserIdBySubOrCustomer({ subId, customerId }) {
  if (subId) {
    const r1 = await query(
      `select line_user_id from users where stripe_subscription_id=$1 limit 1`,
      [subId]
    );
    const id1 = r1.rows?.[0]?.line_user_id || null;
    if (id1) return id1;
  }

  if (customerId) {
    const r2 = await query(
      `select line_user_id from users where stripe_customer_id=$1 limit 1`,
      [customerId]
    );
    const id2 = r2.rows?.[0]?.line_user_id || null;
    if (id2) return id2;
  }

  return null;
}

/**
 * ✅ invoice系の共通処理（paid/succeeded/paid）：
 *  - subId/customerId からユーザーを引いて、subscription を retrieve して current_period_end を確定
 */
async function handleInvoicePaidLike(event) {
  const inv = event.data.object;

  const subId = toId(inv.subscription);
  const customerId = toId(inv.customer);

  console.log("[stripe] invoice paid-like start", {
    eventType: event.type,
    invoiceId: inv?.id,
    subId,
    customerId,
  });

  if (!subId || !customerId) {
    console.log("[stripe] invoice paid-like missing subId/customerId", { subId, customerId });
    return;
  }

  const lineUserId = await findLineUserIdBySubOrCustomer({ subId, customerId });
  if (!lineUserId) {
    console.log("[stripe] invoice paid-like user not found", { subId, customerId });
    return;
  }

  console.log("[stripe] invoice paid-like before retrieve subscription", { subId });
  const sub = await stripe.subscriptions.retrieve(subId);
  console.log("[stripe] invoice paid-like after retrieve subscription", {
    status: sub?.status,
    current_period_end: sub?.current_period_end,
  });

  console.log("[stripe] invoice paid-like before upsertUserPaid", { lineUserId });
  await upsertUserPaid({
    lineUserId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subId,
    status: sub?.status || "active",
    currentPeriodEndUnix: sub?.current_period_end ?? null,
  });
  console.log("[stripe] invoice paid-like after upsertUserPaid", { lineUserId });
}

function mountStripeRoutes(app) {
  // Checkout作成（サブスク）
  app.post("/stripe/checkout", app.jsonParser, async (req, res) => {
    try {
      const { lineUserId } = req.body || {};
      if (!lineUserId) return res.status(400).json({ ok: false, error: "missing_lineUserId" });

      const existing = await getUser(lineUserId);
      if (isActiveUserRow(existing)) {
        return res.json({ ok: true, alreadyPaid: true });
      }

      const baseUrl = process.env.APP_BASE_URL;
      const priceId = process.env.STRIPE_PRICE_ID;
      if (!baseUrl) return res.status(500).json({ ok: false, error: "missing_APP_BASE_URL" });
      if (!priceId) return res.status(500).json({ ok: false, error: "missing_STRIPE_PRICE_ID" });

      // （任意）priceの存在確認ログ
      const price = await stripe.prices.retrieve(priceId);
      console.log("✅ PRICE LOOKUP", {
        id: price.id,
        livemode: price.livemode,
        active: price.active,
        currency: price.currency,
        unit_amount: price.unit_amount,
        recurring: price.recurring ? { interval: price.recurring.interval } : null,
        product: typeof price.product === "string" ? price.product : price.product?.id,
      });

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}/billing/success`,
        cancel_url: `${baseUrl}/billing/cancel`,
        client_reference_id: lineUserId,
        metadata: { lineUserId, plan: "sara_980_monthly" },
        allow_promotion_codes: false,
      });

      // paymentsログ（冪等のため）
      await query(
        `
        insert into payments (checkout_session_id, line_user_id, status)
        values ($1,$2,$3)
        on conflict (checkout_session_id) do nothing
        `,
        [session.id, lineUserId, "created"]
      );

      return res.json({ ok: true, url: session.url, checkoutSessionId: session.id });
    } catch (e) {
      console.error("[stripe/checkout] error message:", e?.message);
      console.error("[stripe/checkout] error code:", e?.code);
      console.error("[stripe/checkout] error detail:", e?.detail);
      console.error("[stripe/checkout] error table:", e?.table);
      console.error("[stripe/checkout] error schema:", e?.schema);
      console.error("[stripe/checkout] error routine:", e?.routine);
      console.error("[stripe/checkout] error stack:", e?.stack);

      return res.status(500).json({
        ok: false,
        error: "checkout_failed",
        debug: {
          message: e?.message,
          code: e?.code,
          detail: e?.detail,
          table: e?.table,
          schema: e?.schema,
          routine: e?.routine,
        },
      });
    }
  });

  // Webhook（raw body必須）
  app.post("/stripe/webhook", app.rawParser, async (req, res) => {
    let event;

    // ✅ 到達ログ（Renderで確認しやすい）
    console.log("⚡ /stripe/webhook HIT", new Date().toISOString());
    console.log("has stripe-signature:", !!req.headers["stripe-signature"]);

    // 1) 署名検証（ここが落ちたら400）
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

      // ✅ verifiedログ（これが出たら「署名OK＆raw OK」）
      console.log("[stripe/webhook] verified", {
        id: event.id,
        type: event.type,
        livemode: event.livemode,
        created: event.created,
      });
    } catch (err) {
      console.error("[stripe/webhook] signature verify failed", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 2) 本処理（ここで何が起きても必ずレスポンス返す）
    try {
      // ✅ 冪等
      if (await alreadyProcessed(event.id)) {
        console.log("[stripe/webhook] dedup skip", { id: event.id, type: event.type });
        return res.status(200).json({ received: true, dedup: true });
      }

      switch (event.type) {
        // ✅ Checkout完了：subscription/customer を users に紐付ける
        case "checkout.session.completed": {
          const session = event.data.object;

          console.log("[stripe] checkout.session.completed start", { sessionId: session?.id });

          const lineUserId = session.client_reference_id || session.metadata?.lineUserId;
          console.log("[stripe] checkout lineUserId", { lineUserId });

          if (!lineUserId) {
            console.log("[stripe] checkout.session.completed missing lineUserId");
            break;
          }

          const subId = toId(session.subscription);
          const customerId = toId(session.customer);

          console.log("[stripe] checkout ids", { subId, customerId });

          console.log("[stripe] checkout before retrieve subscription");
          let sub = null;
          if (subId) sub = await stripe.subscriptions.retrieve(subId);
          console.log("[stripe] checkout after retrieve subscription", {
            status: sub?.status,
            current_period_end: sub?.current_period_end,
          });

          console.log("[stripe] checkout before upsertUserPaid");
          await upsertUserPaid({
            lineUserId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subId,
            status: sub?.status || "active",
            currentPeriodEndUnix: sub?.current_period_end ?? null,
          });
          console.log("[stripe] checkout after upsertUserPaid");

          console.log("[stripe] checkout before update payments");
          await query(
            `
            update payments
            set status=$2,
                stripe_subscription_id=$3
            where checkout_session_id=$1
            `,
            [session.id, "paid", subId]
          );
          console.log("[stripe] checkout after update payments");

          break;
        }

        /**
         * ✅ 支払い成功（請求が確定して“最強に確実”）
         *  - Stripe UIでよく出る：invoice.payment.paid / invoice.payment_succeeded / invoice.paid
         */
        case "invoice.payment.paid":
        case "invoice.payment_succeeded":
        case "invoice.paid": {
          await handleInvoicePaidLike(event);
          break;
        }

        // ✅ サブスク更新：順序ズレでも拾えるよう customer でフォールバック
        case "customer.subscription.updated": {
          const sub = event.data.object;
          const subId = sub?.id;
          const customerId = toId(sub?.customer);

          console.log("[stripe] subscription.updated start", { subId, customerId, status: sub?.status });

          if (!subId || !customerId) {
            console.log("[stripe] subscription.updated missing ids", { subId, customerId });
            break;
          }

          const lineUserId = await findLineUserIdBySubOrCustomer({ subId, customerId });
          if (!lineUserId) {
            console.log("[stripe] subscription.updated user not found", {
              subId,
              customerId,
              status: sub.status,
            });
            break;
          }

          console.log("[stripe] subscription.updated before upsertUserPaid", { lineUserId });
          await upsertUserPaid({
            lineUserId,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subId,
            status: sub.status,
            currentPeriodEndUnix: sub.current_period_end ?? null,
          });
          console.log("[stripe] subscription.updated after upsertUserPaid", { lineUserId });

          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object;
          console.log("[stripe] subscription.deleted start", { subId: sub?.id, status: sub?.status });

          if (!sub?.id) break;
          await markUserUnpaidBySubscription(sub.id, sub.status || "canceled");

          console.log("[stripe] subscription.deleted done", { subId: sub?.id });
          break;
        }

        default: {
          // 追跡しやすいようにログだけ（必要なら後で足す）
          console.log("[stripe] unhandled event", { type: event.type, id: event.id });
          break;
        }
      }

      // ✅ 冪等マーク（成功時のみ）
      await markProcessed(event.id);

      return res.status(200).json({ received: true });
    } catch (e) {
      console.error("[stripe/webhook] handler error", {
        message: e?.message,
        code: e?.code,
        detail: e?.detail,
        table: e?.table,
        routine: e?.routine,
        stack: e?.stack,
      });

      // Stripeには「失敗」として見せたいので received:true は返さない
      return res.status(500).json({ received: false, error: "handler_failed" });
    }
  });

  // 見た目用（確定はWebhook）
  app.get("/billing/success", (req, res) => {
    res.status(200).send("決済ありがとう💋 LINEに戻って続けな。");
  });

  app.get("/billing/cancel", (req, res) => {
    res
      .status(200)
      .send("キャンセルOK💋 続けたいならLINEで、もう一回『決済して続きを見る』を押しな。");
  });
}

module.exports = { mountStripeRoutes, getUser, isActiveUserRow };