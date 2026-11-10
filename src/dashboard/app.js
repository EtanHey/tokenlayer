function $(s) {
  return document.querySelector(s);
}
function text(tag, value) {
  const e = document.createElement(tag);
  e.textContent = value;
  return e;
}
const csrf = $('meta[name="csrf-token"]').content;
let latestState = null,
  latestAccounts = [];
let ready = false,
  inflight = false,
  retryBody = null;
async function api(path, body) {
  const r = await fetch(
    "/api/" + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Request failed (" + r.status + ")");
  return data;
}
function time(v) {
  if (!v) return "UNKNOWN";
  const d = new Date(typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) * 1000 : v);
  return isNaN(d)
    ? "UNKNOWN"
    : d.toLocaleString("en-GB", { timeZone: "Asia/Jerusalem", timeZoneName: "short" });
}
function meter(card, name, q) {
  card.append(
    text(
      "p",
      name +
        ": " +
        (q.utilization === null ? "UNKNOWN" : Math.round(q.utilization * 100) + "%") +
        " · " +
        q.status,
    ),
  );
  const m = document.createElement("meter");
  m.min = 0;
  m.max = 1;
  m.low = 0.8;
  m.high = 0.95;
  m.optimum = 0;
  m.setAttribute("aria-label", name + " used");
  m.value = q.utilization ?? 0;
  card.append(
    m,
    text(
      "small",
      "Resets " +
        time(q.reset) +
        " · observed " +
        time(q.observed_at) +
        (q.stale ? " · STALE" : ""),
    ),
  );
}
function exclusions(c) {
  return c.email + ": " + c.catalog.length + " available models · priority " + (c.priority ?? "baseline");
}
async function refresh() {
  if (inflight) return;
  inflight = true;
  const paths = ["state", "accounts", "metrics?window=48h", "burn", "recommendation"];
  const panels = ["#events", "#accounts", "#chart", "#freshness", "#recommendation"];
  try {
    const results = await Promise.allSettled(
      paths.map(function callback1(p) {
        return api(p);
      }),
    );
    results.forEach(function callback2(result, i) {
      if (result.status === "rejected")
        $(panels[i]).textContent = paths[i] + ": " + result.reason.message;
    });
    const [s, a, m, b, r] = results.map(function callback3(x) {
      return x.status === "fulfilled" ? x.value : null;
    });
    if (a) {
      latestAccounts = a;
      $("#mode").textContent = "Management API readback: " + a.map(exclusions).join(" · ");
      $("#accounts").replaceChildren();
      for (const c of a) {
        const card = text("article", "");
        card.append(text("h2", c.email), text("p", c.status));
        meter(card, "Weekly", c.weekly);
        meter(card, "Fable cap (of the 50% allowance)", c.fable);
        card.append(
          text("p", exclusions(c)),
          text(
            "p",
            "Cooldowns: " +
              (c.cooldowns?.length
                ? c.cooldowns
                    .map(function cooldown(x) {
                      return (
                        x.scope +
                        " · " +
                        (x.model_key || "all models") +
                        " · retry " +
                        time(x.retry_at)
                      );
                    })
                    .join("; ")
                : "none"),
          ),
        );
        if (b)
          card.append(
            text(
              "p",
              "Estimated cap: " +
                (b.projections
                  .filter(function callback4(p) {
                    return p.key.startsWith(c.email);
                  })
                  .map(function callback5(p) {
                    return time(p.projectedCapAt);
                  })
                  .join(", ") || "insufficient observations"),
            ),
          );
        $("#accounts").append(card);
      }
      for (const select of document.querySelectorAll(".account")) {
        const prior = select.value;
        select.replaceChildren();
        for (const c of a) {
          const opt = text("option", c.email);
          opt.value = c.email;
          select.append(opt);
        }
        if (
          a.some(function callback6(c) {
            return c.email === prior;
          })
        )
          select.value = prior;
      }
    }
    if (s) {
      latestState = s;
      updateToggle();
      if (!ready) {
        const f = $("#switch");
        f.mode.value = s.state.mode;
        f.account.value =
          s.state.fableAccount ||
          a?.find(function preferred(c) {
            return c.email.includes("etanface");
          })?.email ||
          a?.[0]?.email;
        f.strict.checked = s.state.strictFableAccount;
        f.spillover.checked = s.state.spillover;
        f.allowNonFableOnFableAccount.checked = s.state.allowNonFableOnFableAccount;
        ready = true;
      }
      $("#inventory").textContent = Object.entries(s.state.resets || {})
        .map(function callback7([email, v]) {
          return (
            email +
            ": " +
            (v.left ?? "unknown") +
            " left" +
            (v.confirmedByEtan ? " · confirmed" : " · unconfirmed")
          );
        })
        .join("\n");
      $("#recovery").textContent = Object.values(s.state.resetOps || {})
        .map(function callback8(v) {
          return v.recovery + " " + v.hint;
        })
        .join("\n");
      $("#coverage").replaceChildren(
        ...s.coverage.map(function callback9(x) {
          return text("li", x);
        }),
      );
      $("#events").replaceChildren(
        ...s.events
          .slice()
          .reverse()
          .map(function callback10(x) {
            return text(
              "p",
              time(x.at) +
                " · " +
                (x.who || "controller") +
                " · " +
                x.stage +
                " " +
                (x.status || ""),
            );
          }),
      );
    }
    if (r)
      $("#recommendation").replaceChildren(
        ...r.map(function callback11(x) {
          return Object.assign(
            text(
              "p",
              x.account + " · " + x.verdict + " · " + x.reason,
            ),
            { title: x.reason },
          );
        }),
      );
    if (m) {
      $("#freshness").textContent = "Drain latest: " + time(m.freshness[0]?.last_at);
      $("#errors").textContent =
        "429s: " +
        m.rows.reduce(function callback12(n, x) {
          return n + Number(x.errors429);
        }, 0);
      draw(m.rows);
    }
    results.forEach(function stamp(result, i) {
      const panel = $(panels[i]);
      if (result.status === "fulfilled")
        panel.append(
          Object.assign(text("small", "As of " + time(Date.now())), { className: "as-of" }),
        );
    });
    updateFacts();
    if (s) $("#mismatch").textContent = ["ON", "OFF"].includes(s.applied) ? "" : s.reason;
    $("#notice").textContent = "Updated " + time(new Date().toISOString());
  } finally {
    inflight = false;
  }
}
function draw(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.account + " / " + r.model;
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  $("#chart").replaceChildren();
  for (const [name, rs] of groups) {
    const box = text("div", "");
    box.append(text("h3", name));
    for (const field of ["requests", "tokens"]) {
      box.append(text("small", field));
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 600 100");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", field + " over 48 hours");
      const max = Math.max(
        1,
        ...rs.map(function callback13(r) {
          return Number(r[field]);
        }),
      );
      const times = rows.map(function callback14(r) {
        return Date.parse(r.hour.replace(" ", "T") + "Z");
      });
      const start = Math.min(...times);
      const end = Math.max(...times) + 3600000;
      box.append(
        text(
          "small",
          "Max " +
            max +
            " · " +
            time(start) +
            " to " +
            time(end) +
            " · 429s " +
            rs.reduce(function callback15(n, r) {
              return n + Number(r.errors429);
            }, 0),
        ),
      );
      rs.forEach(function callback16(r, i) {
        const bar = document.createElementNS(svg.namespaceURI, "rect");
        bar.setAttribute(
          "x",
          String(((Date.parse(r.hour.replace(" ", "T") + "Z") - start) / (end - start)) * 600),
        );
        bar.setAttribute("y", String(95 - (Number(r[field]) / max) * 90));
        bar.setAttribute("width", String(Math.max(1, (3600000 / (end - start)) * 600 - 2)));
        bar.setAttribute("height", String((Number(r[field]) / max) * 90));
        bar.setAttribute("fill", field === "requests" ? "#68aa90" : "#7b9bcb");
        const title = document.createElementNS(svg.namespaceURI, "title");
        title.textContent = r.hour + ": " + r[field] + " " + field;
        bar.append(title);
        svg.append(bar);
      });
      box.append(svg);
    }
    $("#chart").append(box);
  }
}
for (const [id, path] of [
  ["switch", "switch"],
  ["counts", "resets"],
  ["pressed", "reset-pressed"],
])
  $("#" + id).onsubmit = async function submitForm(e) {
    e.preventDefault();
    if (
      !confirm(
        id === "pressed"
          ? "Confirm you already pressed a reset in Claude?"
          : id === "switch" ? "Change Fable split routing for " + e.target.account.value + "?"
          : "Confirm this change?",
      )
    )
      return;
    const f = e.target,
      body = { account: f.account.value };
    if (id === "switch")
      Object.assign(body, {
        on: latestState?.state.requested?.mode !== "manual",
        strict: f.strict.checked,
        spillover: f.spillover.checked,
        allowNonFableOnFableAccount: f.allowNonFableOnFableAccount.checked,
      });
    if (id === "counts")
      Object.assign(body, { left: Number(f.left.value), confirmed: f.confirmed.checked });
    if (id === "pressed") {
      body.opId = crypto.randomUUID();
      f.opId.value = body.opId;
      retryBody = body;
    }
    try {
      await api(path, body);
      if (id === "pressed") {
        retryBody = null;
        $("#retry").hidden = true;
      }
      await refresh();
    } catch (e) {
      $("#notice").textContent = e.message;
      if (id === "pressed") $("#retry").hidden = false;
    }
  };
function updateToggle() {
  const applied = latestState?.applied ?? "UNKNOWN";
  const on = latestState?.requested?.mode === "manual";
  $("#applied").textContent = "Fable split: " + applied;
  $("#applied-reason").textContent = applied === "ON_WAIT_AT_CAP"
    ? "Fable paused at its cap on " + latestState.state.fableAccount +
      ": press a reset in Claude when you want more"
    : ["ON", "OFF"].includes(applied) ? "" : latestState?.reason;
  $("#toggle").textContent = on ? "Turn OFF" : "Turn Fable split ON";
  $("#toggle").setAttribute("aria-pressed", String(applied === "ON"));
}
function updateFacts() {
  const account = $("#pressed").account.value;
  const c = latestAccounts.find(function selected(c) {
    return c.email === account;
  });
  const count = latestState?.state.resets?.[account];
  $("#reset-facts").textContent =
    account +
    " · " +
    (count?.left ?? "unknown") +
    " resets left · " +
    "weekly reset " +
    time(c?.weekly.reset) +
    " · Fable reset " +
    time(c?.fable.reset);
}
$("#pressed").account.onchange = updateFacts;
refresh();
setInterval(refresh, 30000);
$("#retry").onclick = async function retry() {
  try {
    await api("reset-pressed", retryBody);
    retryBody = null;
    this.hidden = true;
    await refresh();
  } catch (e) {
    $("#notice").textContent = e.message;
  }
};
