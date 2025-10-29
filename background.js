// background.js
chrome.runtime.onInstalled.addListener(async () => {
  console.log("AutoForm Filler installed");
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (e) {
    console.warn("sidePanel behavior not set", e);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "openPanel") {
        try {
          if (chrome.sidePanel && chrome.sidePanel.open) {
            const [tab] = await chrome.tabs.query({
              active: true,
              currentWindow: true,
            });
            await chrome.sidePanel.open({ windowId: tab?.windowId });
            sendResponse({ success: true, mode: "sidePanel" });
          } else {
            // Fallback: open a detached popup window
            const url = chrome.runtime.getURL("popup.html");
            await chrome.windows.create({
              url,
              type: "popup",
              width: 380,
              height: 720,
            });
            sendResponse({ success: true, mode: "window" });
          }
        } catch (e) {
          sendResponse({ success: false, error: e?.message || String(e) });
        }
        return;
      }
      if (message.type === "login") {
        console.log(message);
        // message: {type:'login', apiBase, email, password}
        const apiBase = (message.API_BASE || "").replace(/\/$/, "");
        const res = await fetch(`${apiBase}/api/extension-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: message.email,
            password: message.password,
          }),
        });
        const body = await res.json();
        console.log(body);
        if (!res.ok) {
          sendResponse({ success: false, error: body.error || res.statusText });
          return;
        }
        await chrome.storage.local.set({ token: body.token, apiBase });
        sendResponse({ success: true, data: body });
        return;
      }

      if (message.type === "fetchData") {
        // message: {type:'fetchData'} -- uses stored apiBase/token
        const store = await chrome.storage.local.get(["token", "apiBase"]);
        const token = store.token;
        const apiBase = message.API_BASE;
        if (!token || !apiBase) {
          sendResponse({ success: false, error: "Not authenticated" });
          return;
        }
        console.log(`${apiBase}/api/ext/get-data`);
        const res = await fetch(`${apiBase}/api/ext/get-data`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json();
        sendResponse({ success: res.ok, data: body.data, status: res.status });
        return;
      }

      if (message.type === "saveSelection") {
        // message.data = object to persist
        await chrome.storage.local.set({ selectedData: message.data });
        sendResponse({ success: true });
        return;
      }

      if (message.type === "getSelection") {
        const store = await chrome.storage.local.get("selectedData");
        sendResponse({ success: true, data: store.selectedData });
        return;
      }

      if (message.type === "clearSelection") {
        await chrome.storage.local.remove("selectedData");
        sendResponse({ success: true });
        return;
      }

      if (message.type === "injectFill") {
        // message.data = object; message.tabId optional (sender.tab.id used otherwise)
        const tabId = message.tabId || (sender.tab && sender.tab.id);
        if (!tabId) {
          sendResponse({ success: false, error: "No active tab ID" });
          return;
        }

        // Inject a function into the page to fill the form.
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (formData) => {
            // --- filler runs inside the webpage ---
            const inputSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype,
              "value"
            )?.set;
            const textareaSetter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype,
              "value"
            )?.set;

            function fire(el, type, opts = {}) {
              const common = { bubbles: true, cancelable: true, composed: true, ...opts };
              let ev;
              if (type === "input") {
                try {
                  ev = new InputEvent("input", common);
                } catch (_) {
                  ev = new Event("input", common);
                }
              } else if (type.startsWith("key")) {
                ev = new KeyboardEvent(type, { key: opts.key || "", ...common });
              } else if (["click","mousedown","mouseup","mouseover"].includes(type)) {
                ev = new MouseEvent(type, common);
              } else {
                ev = new Event(type, common);
              }
              try { el.dispatchEvent(ev); } catch (_) {}
            }

            function focusAndSelect(el) {
              try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
              try {
                if (typeof el.select === "function") el.select();
              } catch (_) {}
            }

            function setTextLike(el, value) {
              const text = String(value ?? "");
              focusAndSelect(el);
              // Clear existing value using native setter where possible
              if (el.tagName?.toLowerCase() === "textarea" && textareaSetter) {
                textareaSetter.call(el, "");
              } else if (el.tagName?.toLowerCase() === "input" && inputSetter) {
                inputSetter.call(el, "");
              } else if (el.isContentEditable) {
                try { document.execCommand("selectAll", false); document.execCommand("delete", false); } catch (_) { el.textContent = ""; }
              } else {
                el.value = "";
              }
              fire(el, "input", { data: "", inputType: "deleteContent" });

              // Type character-by-character to mimic a real user
              let current = "";
              for (const ch of text) {
                // keydown / keypress
                fire(el, "keydown", { key: ch });
                fire(el, "keypress", { key: ch });
                // beforeinput + set via native setter
                try { fire(el, "beforeinput", { data: ch, inputType: "insertText" }); } catch (_) {}
                current += ch;
                if (el.tagName?.toLowerCase() === "textarea" && textareaSetter) {
                  textareaSetter.call(el, current);
                } else if (el.tagName?.toLowerCase() === "input" && inputSetter) {
                  inputSetter.call(el, current);
                } else if (el.isContentEditable) {
                  try { document.execCommand("insertText", false, ch); } catch (_) { el.textContent = current; }
                } else {
                  el.value = current;
                }
                // input + keyup
                fire(el, "input", { data: ch, inputType: "insertText" });
                fire(el, "keyup", { key: ch });
              }
              // Finalize
              fire(el, "change");
              fire(el, "blur");
            }

            function setCheckboxRadio(el, value) {
              const want = !!value;
              if (el.type?.toLowerCase() === "radio") {
                if (!el.checked) {
                  fire(el, "mouseover");
                  fire(el, "mousedown");
                  fire(el, "mouseup");
                  try { el.click(); } catch (_) { el.checked = true; }
                  fire(el, "change");
                  fire(el, "blur");
                }
                return;
              }
              if (el.checked !== want) {
                fire(el, "mouseover");
                fire(el, "mousedown");
                fire(el, "mouseup");
                try { el.click(); } catch (_) { el.checked = want; }
                fire(el, "change");
              }
              fire(el, "blur");
            }

            function setSelect(el, value) {
              let v = value;
              const opts = Array.from(el.options || []);
              // Try to match by value first, then by text
              let match = opts.find(o => o.value == v);
              if (!match) match = opts.find(o => (o.textContent || "").trim().toLowerCase() === String(v).trim().toLowerCase());
              if (match) {
                el.value = match.value;
                match.selected = true;
              } else {
                el.value = v;
              }
              fire(el, "input");
              fire(el, "change");
              fire(el, "blur");
            }

            function setValue(el, value) {
              if (!el) return;
              const tag = el.tagName?.toLowerCase();
              if (tag === "input") {
                const t = el.type?.toLowerCase();
                if (t === "checkbox" || t === "radio") {
                  setCheckboxRadio(el, value);
                } else {
                  setTextLike(el, value);
                }
              } else if (tag === "textarea") {
                setTextLike(el, value);
              } else if (tag === "select") {
                setSelect(el, value);
              } else if (el.isContentEditable) {
                setTextLike(el, value);
              } else {
                // Fallback
                el.value = value;
                fire(el, "input");
                fire(el, "change");
                fire(el, "blur");
              }
            }

            const inputs = Array.from(
              document.querySelectorAll("input, textarea, select")
            );

            // --- FILL FIELDS ---
            for (const key in formData) {
              const val = formData[key];
              const keyLower = key.toLowerCase();
              let el = null;

              // 1️⃣ exact match by name/id
              el = document.querySelector(`[name="${key}"], #${key}`);
              if (!el) {
                // 2️⃣ partial match by name/id
                el = inputs.find(
                  (i) =>
                    (i.name && i.name.toLowerCase().includes(keyLower)) ||
                    (i.id && i.id.toLowerCase().includes(keyLower))
                );
              }

              // 3️⃣ placeholder or label includes key
              if (!el) {
                el = inputs.find((i) => {
                  const ph = (i.placeholder || "").toLowerCase();
                  const label = document.querySelector(`label[for="${i.id}"]`);
                  return (
                    ph.includes(keyLower) ||
                    (label &&
                      label.textContent.toLowerCase().includes(keyLower))
                  );
                });
              }

              if (el) {
                console.log(`Filling ${key} → ${val}`);
                setValue(el, val);
              } else {
                console.log(`No match for key: ${key}`);
              }
            }

            // --- HANDLE re-enter password ---
            const pwd = formData.password || formData.pass || formData.pwd;
            if (pwd) {
              const rePwdInput = inputs.find(
                (i) =>
                  (i.name && i.name.toLowerCase().includes("passwordcheck")) ||
                  (i.id && i.id.toLowerCase().includes("ap_password_check")) ||
                  (i.placeholder &&
                    i.placeholder.toLowerCase().includes("confirm"))
              );
              if (rePwdInput) {
                console.log("Filling re-enter password field");
                setValue(rePwdInput, pwd);
              }
            }

            // --- AMAZON KDP explicit mapping (best effort) ---
            try {
              const host = location.hostname || "";
              if (host.includes("amazon.") || host.includes("kdp.amazon")) {
                const nameVal = formData.customerName || formData.name || formData.fullName;
                if (nameVal) {
                  const el = document.getElementById("ap_customer_name");
                  if (el) setValue(el, nameVal);
                }
                if (formData.email) {
                  const el = document.getElementById("ap_email");
                  if (el) setValue(el, formData.email);
                }
                if (pwd) {
                  const el1 = document.getElementById("ap_password");
                  const el2 = document.getElementById("ap_password_check");
                  if (el1) setValue(el1, pwd);
                  if (el2) setValue(el2, pwd);
                }
              }
            } catch (_) {}

            // Do not auto-submit; only fill
            return;

            // --- CLICK continue/submit button ---
            function visible(el) {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              return (
                style.visibility !== "hidden" &&
                style.display !== "none" &&
                el.offsetParent !== null
              );
            }

            function findSubmitLike() {
              const explicitSelectors = [
                "#signInSubmit",
                "#continue",
                "input#continue",
                "input#signInSubmit",
                "button#continue",
                "button#signInSubmit",
                'input[name="signInSubmit"]',
                'input[name="continue"]',
              ];
              for (const sel of explicitSelectors) {
                const el = document.querySelector(sel);
                if (visible(el)) return el;
              }

              const buttons = Array.from(
                document.querySelectorAll(
                  'button, input[type="submit"], input[type="button"], a[role="button"], div[role="button"], span[role="button"]'
                )
              ).filter(visible);
              const keywords = [
                "continue",
                "submit",
                "sign in",
                "signin",
                "log in",
                "login",
                "next",
                "save",
                "confirm",
                "proceed",
              ];
              let el =
                document.getElementById("continue") ||
                document.getElementById("submit") ||
                document.getElementById("signInSubmit");
              if (visible(el)) return el;
              const norm = (s) => (s || "").toLowerCase().trim();
              const hasKeyword = (s) =>
                keywords.some((k) => norm(s).includes(k));
              el = buttons.find(
                (b) =>
                  hasKeyword(b.id) ||
                  hasKeyword(b.value) ||
                  hasKeyword(b.textContent) ||
                  hasKeyword(b.getAttribute && b.getAttribute("aria-label"))
              );
              if (visible(el)) return el;
              el = document.querySelector(
                'button[type="submit"], input[type="submit"]'
              );
              if (visible(el)) return el;
              return buttons[0] || null;
            }

            function realClick(el) {
              try {
                el.scrollIntoView({ block: "center", behavior: "instant" });
              } catch (_) {}
              const ev = (type) =>
                new MouseEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                });
              el.dispatchEvent(ev("mouseover"));
              el.dispatchEvent(ev("mousedown"));
              el.dispatchEvent(ev("mouseup"));
              el.dispatchEvent(ev("click"));
            }

            function attemptSubmit(maxAttempts = 12, delay = 250) {
              let tries = 0;
              const tick = () => {
                const el = findSubmitLike();
                if (el) {
                  console.log("Submitting form via:", el);
                  try {
                    const form = el.closest && el.closest("form");
                    if (form && typeof form.requestSubmit === "function") {
                      if (el.tagName && el.tagName.toLowerCase() === "button") {
                        form.requestSubmit(el);
                      } else {
                        form.requestSubmit();
                      }
                    } else {
                      realClick(el);
                    }
                  } catch (_) {
                    realClick(el);
                  }
                } else if (tries < maxAttempts) {
                  tries++;
                  setTimeout(tick, delay);
                } else {
                  console.log(
                    "Submit/continue button not found after retries."
                  );
                }
              };
              setTimeout(tick, delay);
            }

            // Allow validations/bindings to react, then try repeatedly
            attemptSubmit(12, 250);
          },
          args: [message.data],
        });
        sendResponse({ success: true });
        return;
      }

      if (message.type === "injectFillAddress") {
        const tabId = message.tabId || (sender.tab && sender.tab.id);
        if (!tabId) {
          sendResponse({ success: false, error: "No active tab ID" });
          return;
        }

        await chrome.scripting.executeScript({
          target: { tabId },
          func: (data) => {
            function trigger(el, type) {
              try {
                el.dispatchEvent(new Event(type, { bubbles: true }));
              } catch (_) {}
            }
            function setValue(el, value) {
              if (!el) return;
              const tag = el.tagName?.toLowerCase();
              if (tag === "input") {
                const t = el.type?.toLowerCase();
                if (t === "checkbox" || t === "radio") {
                  el.checked = !!value;
                } else {
                  el.value = value;
                }
              } else if (tag === "textarea" || tag === "select") {
                el.value = value;
              } else if (el.isContentEditable) {
                el.textContent = value;
              }
              trigger(el, "input");
              trigger(el, "change");
              trigger(el, "blur");
            }

            function findByKey(keywords) {
              const inputs = Array.from(
                document.querySelectorAll("input, select, textarea")
              );
              const needles = keywords.map((k) => k.toLowerCase());
              const match = (txt) =>
                !!txt &&
                needles.some((k) => String(txt).toLowerCase().includes(k));

              function ariaLabeledText(el) {
                const al = el.getAttribute?.("aria-label");
                if (al) return al;
                const ids = (el.getAttribute?.("aria-labelledby") || "")
                  .split(/\s+/)
                  .filter(Boolean);
                if (!ids.length) return "";
                return ids
                  .map((id) => document.getElementById(id))
                  .filter(Boolean)
                  .map((n) => n.textContent || "")
                  .join(" ");
              }

              return (
                inputs.find((i) => match(i.name) || match(i.id)) ||
                inputs.find((i) => match(i.placeholder)) ||
                inputs.find((i) => match(ariaLabeledText(i))) ||
                inputs.find((i) => {
                  const label = i.id
                    ? document.querySelector(`label[for="${i.id}"]`)
                    : null;
                  return label && match(label.textContent || "");
                })
              );
            }

            // Full Name
            const fullNameEl = findByKey(["full name", "name", "legal name"]);
            if (fullNameEl && data.fullName)
              setValue(fullNameEl, data.fullName);

            // Address lines
            const addr1El =
              document.getElementById("identity-form-address-line-1") ||
              document.querySelector("#identity-form-address-line-1") ||
              findByKey([
                "address line 1",
                "Address Line 1*",
                "address1",
                "street",
                "address",
              ]);
            if (addr1El && data.address1) setValue(addr1El, data.address1);

            // City
            const cityEl = findByKey(["city", "town", "kota"]);
            if (cityEl && data.city) setValue(cityEl, data.city);

            // State / Province / Region
            const stateEl = findByKey([
              "state",
              "province",
              "region",
              "state/province/region",
              "provinsi",
            ]);
            if (stateEl && data.state) setValue(stateEl, data.state);

            // Postal / ZIP
            const postalEl = findByKey([
              "postal",
              "zip",
              "postcode",
              "kode pos",
            ]);
            if (postalEl && data.postalCode)
              setValue(postalEl, data.postalCode);

            // Country (ideally a select)
            // Custom combobox for country (e.g., mdn select)
            const countryEl = findByKey(["country", "negara"]);
            const countryContainer = document.querySelector(
              '[data-testid="identity-form-country"]'
            );
            let countryCombo = countryContainer?.querySelector(
              'input[role="combobox"]'
            );
            if (
              !countryCombo &&
              countryEl &&
              countryEl.getAttribute?.("role") === "combobox"
            ) {
              countryCombo = countryEl;
            }

            // DOB (input type=date or text)
            const dobEl = findByKey(["date of birth", "dob", "birth"]);
            if (dobEl && data.dob) {
              // Accept YYYY-MM-DD; adjust if input type=date
              let val = data.dob;
              if (dobEl.type?.toLowerCase() === "date") {
                // if value looks like MM/DD/YYYY convert to YYYY-MM-DD
                const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(val);
                if (m) {
                  const [_, mm, dd, yyyy] = m;
                  val = `${yyyy}-${String(mm).padStart(2, "0")}-${String(
                    dd
                  ).padStart(2, "0")}`;
                }
              }
              setValue(dobEl, val);
            }

            // Phone
            const phoneEl = findByKey(["phone", "mobile", "telepon", "hp"]);
            if (phoneEl && data.phone) setValue(phoneEl, data.phone);

            if ((countryEl || countryCombo) && data.country) {
              if (countryEl && countryEl.tagName?.toLowerCase() === "select") {
                const want = (data.country || "").toLowerCase();
                const code = (data.countryCode || "").toLowerCase();
                let matched = false;
                Array.from(countryEl.options || []).forEach((opt) => {
                  const val = (opt.value || "").toLowerCase();
                  const txt = (opt.textContent || "").toLowerCase();
                  if (
                    txt.includes(want) ||
                    val.includes(want) ||
                    val === code ||
                    txt.includes(code)
                  ) {
                    countryEl.value = opt.value;
                    matched = true;
                  }
                });
                if (!matched)
                  countryEl.value =
                    countryEl.value || countryEl.options?.[0]?.value;
                trigger(countryEl, "change");
              } else if (countryCombo) {
                const label = data.country;
                const tryPick = () => {
                  const listId = countryCombo.getAttribute("aria-controls");
                  const list = listId
                    ? document.getElementById(listId)
                    : document.querySelector('[role="listbox"]');
                  if (!list) return false;
                  const options = Array.from(
                    list.querySelectorAll('[role="option"], li, div')
                  );
                  const want = label.toLowerCase();
                  const code = (data.countryCode || "").toLowerCase();
                  const opt = options.find((o) => {
                    const t = (o.textContent || "").toLowerCase();
                    const v = (
                      o.getAttribute?.("data-value") || ""
                    ).toLowerCase();
                    return (
                      t.includes(want) ||
                      v.includes(want) ||
                      t.includes(code) ||
                      v === code
                    );
                  });
                  if (opt) {
                    opt.click();
                    trigger(countryCombo, "change");
                    countryCombo.blur();
                    return true;
                  }
                  return false;
                };

                countryCombo.focus();
                countryCombo.click();
                countryCombo.value = "";
                trigger(countryCombo, "input");
                countryCombo.value = label;
                trigger(countryCombo, "input");
                setTimeout(() => {
                  if (!tryPick()) {
                    // try opening again and picking by code
                    countryCombo.click();
                    setTimeout(() => {
                      tryPick();
                    }, 120);
                  }
                }, 120);
              } else if (countryEl) {
                setValue(countryEl, data.country);
              }
            }
          },
          args: [message.data],
        });
        sendResponse({ success: true });
        return;
      }

      if (message.type === "getNumber") {
        try {
          const { token } = await chrome.storage.local.get("token");
          if (!token) {
            sendResponse({ success: false, error: "Not logged in" });
            return;
          }

          const res = await fetch(`${message.API_BASE}/api/number/buy`, {
            headers: { Authorization: `Bearer ${token}` },
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || res.statusText);

          const number = data.data.phone;
          const id = data.data.id;
          const country = data.data.country;
          const countryCode = data.data.countryCode;
          if (number) {
            await chrome.storage.local.set({
              number,
              id,
              country,
              countryCode,
            });
            sendResponse({ success: true, number });
          } else {
            sendResponse({ success: false, error: "No number in response" });
          }
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        return true; // keeps message channel open for async response
      }

      if (message.type === "fillPhoneForm") {
        const { tabId, data } = message;

        await chrome.scripting.executeScript({
          target: { tabId },
          func: (formData) => {
            function trigger(el, type) {
              el.dispatchEvent(new Event(type, { bubbles: true }));
            }

            function setValue(el, value) {
              if (!el) return;
              el.value = value;
              trigger(el, "input");
              trigger(el, "change");
            }

            const { country, number, countryCode } = formData;

            // 1️⃣ Select Country
            const selects = Array.from(document.querySelectorAll("select"));
            for (const select of selects) {
              const options = Array.from(select.options);
              const match = options.find(
                (opt) =>
                  opt.value.toLowerCase() === countryCode.toLowerCase() ||
                  opt.textContent
                    .toLowerCase()
                    .includes(countryCode.toLowerCase())
              );

              if (match) {
                select.value = match.value;
                trigger(select, "change");
                console.log("✅ Selected country:", match.textContent);
                break;
              }
            }

            // 2️⃣ Fill Phone Number
            const phoneInput = document.querySelector(
              'input[name*="phone"], input[id*="phone"], input[placeholder*="phone"], input[type="tel"]'
            );

            if (phoneInput) {
              setValue(phoneInput, number);
              console.log("✅ Filled phone:", number);
            } else {
              console.warn("⚠️ Phone input not found");
            }

            // 3️⃣ Click Continue / Collect / Submit Button
            const continueBtn =
              document.getElementById("continue") ||
              document.querySelector('input[name="cvf_action"]') || // <-- added for your case
              Array.from(
                document.querySelectorAll("button, input[type='submit']")
              ).find(
                (b) =>
                  (b.id && b.id.toLowerCase().includes("continue")) ||
                  (b.name && b.name.toLowerCase().includes("continue")) ||
                  (b.value &&
                    ["continue", "next", "submit", "collect"].some((val) =>
                      b.value.toLowerCase().includes(val)
                    )) ||
                  (b.textContent &&
                    ["continue", "next", "submit", "collect"].some((val) =>
                      b.textContent.toLowerCase().includes(val)
                    ))
              );

            if (continueBtn) {
              console.log(
                "✅ Clicking button:",
                continueBtn.value || continueBtn.textContent
              );
              setTimeout(() => continueBtn.click(), 600);
            } else {
              console.warn("⚠️ Continue/Collect button not found");
            }
          },
          args: [data],
        });

        sendResponse({ success: true });
        return true;
      }

      if (message.type === "fillCode") {
        const { tabId, data } = message;

        await chrome.scripting.executeScript({
          target: { tabId },
          func: (formData) => {
            const { code } = formData;

            function trigger(el, type) {
              el.dispatchEvent(new Event(type, { bubbles: true }));
            }

            function setValue(el, value) {
              if (!el) return;
              el.value = value;
              trigger(el, "input");
              trigger(el, "change");
            }

            // 1️⃣ Fill code input field
            const codeInput = document.querySelector(
              'input[name*="code"], input[id*="code"], input[placeholder*="code"]'
            );

            if (codeInput) {
              setValue(codeInput, code);
              console.log("✅ Filled code:", code);
            } else {
              console.warn("⚠️ Code input not found!");
            }

            // 2️⃣ Click the verify button after short delay
            const verifyBtn =
              document.querySelector(
                'input[name="cvf_action"][value="code"]'
              ) ||
              Array.from(
                document.querySelectorAll('input[type="submit"], button')
              ).find(
                (el) =>
                  (el.name && el.name.toLowerCase().includes("cvf_action")) ||
                  (el.ariaLabel &&
                    el.ariaLabel.toLowerCase().includes("verify otp")) ||
                  (el.value && el.value.toLowerCase().includes("code"))
              );

            if (verifyBtn) {
              console.log("✅ Clicking verify OTP button...");
              setTimeout(() => verifyBtn.click(), 600); // wait for input to update
            } else {
              console.warn("⚠️ Verify OTP button not found!");
            }
          },
          args: [data],
        });

        sendResponse({ success: true });
        return true;
      }

      if (message.type === "logout") {
        await chrome.storage.local.remove(["token", "apiBase", "selectedData"]);
        sendResponse({ success: true });
        return;
      }

      sendResponse({ success: false, error: "Unknown message type" });
    } catch (err) {
      console.error("background error", err);
      sendResponse({ success: false, error: err && err.message });
    }
  })();
  return true; // keep message channel open for async response
});
