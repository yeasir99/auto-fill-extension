// popup.js
const API_BASE = "https://www.mdalfahad.us"; // ← change to your real backend

document.addEventListener("DOMContentLoaded", async () => {
  // Theme handling: system/light/dark with persistence
  const root = document.documentElement;
  const themeToggle = document.getElementById("themeToggle");
  const applyTheme = (mode) => {
    if (!mode || mode === "system") {
      root.removeAttribute("data-theme");
      if (themeToggle) {
        const prefersDark = window.matchMedia(
          "(prefers-color-scheme: dark)"
        ).matches;
        themeToggle.textContent = prefersDark ? "☀️" : "🌙";
      }
    } else {
      root.setAttribute("data-theme", mode);
      if (themeToggle) themeToggle.textContent = mode === "dark" ? "☀️" : "🌙";
    }
  };
  try {
    const { theme } = await chrome.storage.local.get("theme");
    applyTheme(theme);
  } catch (_) {
    applyTheme("system");
  }
  themeToggle?.addEventListener("click", async () => {
    const current = root.getAttribute("data-theme") || "system";
    const next =
      current === "dark" ? "light" : current === "light" ? "system" : "dark";
    await chrome.storage.local.set({ theme: next });
    applyTheme(next);
  });

  // OPEN PANEL (persistent UI)
  document.getElementById("btnOpenPanel")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openPanel" }, (resp) => {
      if (!resp?.success) {
        console.warn("Failed to open panel", resp?.error);
      }
    });
  });
  const unauth = document.getElementById("unauth");
  const authed = document.getElementById("authed");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const btnLogin = document.getElementById("btnLogin");
  const btnFetch = document.getElementById("btnFetch");
  const btnLogout = document.getElementById("btnLogout");
  const btnFill = document.getElementById("btnFill");
  const btnClear = document.getElementById("btnClear");
  const dataList = document.getElementById("dataList");
  const status = document.getElementById("status");
  const loginStatus = document.getElementById("loginStatus");

  const setStatus = (text) => {
    if (!status) return;
    if (!text) {
      status.style.display = "none";
      status.textContent = "";
    } else {
      status.style.display = "block";
      status.textContent = text;
    }
  };
  const setLoginStatus = (text) => (loginStatus.textContent = text || "");

  // check authentication on load
  async function checkAuth() {
    const s = await chrome.storage.local.get("token");
    const headerLogout = document.getElementById("btnLogout");
    if (s.token) {
      unauth.style.display = "none";
      authed.style.display = "block";
      if (headerLogout) headerLogout.style.display = "inline-block";
      loadSelection();
    } else {
      unauth.style.display = "block";
      authed.style.display = "none";
      if (headerLogout) headerLogout.style.display = "none";
    }
  }

  // LOGIN HANDLER
  btnLogin.addEventListener("click", () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      setLoginStatus("Please enter email & password");
      return;
    }

    setLoginStatus("Logging in...");
    chrome.runtime.sendMessage(
      { type: "login", API_BASE, email, password },
      (resp) => {
        if (resp && resp.success) {
          setLoginStatus("✅ Logged in");
          checkAuth();
        } else {
          setLoginStatus(
            "❌ Login failed: " + (resp?.error || "Unknown error")
          );
        }
      }
    );
  });

  // LOGOUT HANDLER
  btnLogout.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "logout" }, () => {
      setStatus("Logged out");
      dataList.innerHTML = "";
      checkAuth();
    });
  });

  // FETCH DATA
  btnFetch.addEventListener("click", () => {
    setStatus("Fetching data...");
    chrome.runtime.sendMessage({ type: "fetchData", API_BASE }, (resp) => {
      if (!resp?.success) {
        setStatus("❌ Fetch failed: " + (resp?.error || "Unknown error"));
        return;
      }
      renderList(resp.data || []);
      setStatus(`✅ Loaded ${resp.data?.length || 0} items`);
    });
  });

  // RENDER DATA LIST
  function renderList(items) {
    dataList.innerHTML = "";
    if (!items.length) {
      dataList.innerHTML =
        '<p class="meta" style="text-align:center;">No data available</p>';
      return;
    }

    items.forEach((item, idx) => {
      const div = document.createElement("div");
      div.className = "item";
      div.dataset.idx = idx;
      div.textContent = `Email: ${item.email}`;
      div.addEventListener("click", () => selectItem(item, div));
      dataList.appendChild(div);
    });

    // restore previously selected item
    chrome.runtime.sendMessage({ type: "getSelection" }, (resp) => {
      if (resp?.data) {
        const saved = JSON.stringify(resp.data);
        const allItems = dataList.querySelectorAll(".item");
        allItems.forEach((div) => {
          const current = JSON.stringify(items[Number(div.dataset.idx)]);
          if (current === saved) div.classList.add("selected");
        });
      }
    });
  }

  // SELECT ITEM HANDLER
  function selectItem(item, element) {
    dataList
      .querySelectorAll(".item")
      .forEach((div) => div.classList.remove("selected"));
    element.classList.add("selected");
    chrome.runtime.sendMessage({ type: "saveSelection", data: item }, () => {
      setStatus(`Selected: ${item.email || "Data saved"}`);
    });
  }

  // CLEAR SELECTION
  btnClear.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "clearSelection" }, () => {
      dataList
        .querySelectorAll(".item")
        .forEach((div) => div.classList.remove("selected"));
      setStatus("Selection cleared");
    });
  });

  // FILL FORM
  btnFill.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "getSelection" }, (resp) => {
      if (!resp?.data) {
        setStatus("⚠️ No data selected");
        return;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs[0]?.id;
        if (!tabId) {
          setStatus("❌ No active tab");
          return;
        }
        chrome.runtime.sendMessage(
          { type: "injectFill", tabId, data: resp.data },
          (r) => {
            setStatus(
              r?.success
                ? "✅ Form filled"
                : "❌ Fill failed: " + (r?.error || "")
            );
          }
        );
      });
    });
  });

  // LOAD SAVED SELECTION
  function loadSelection() {
    chrome.runtime.sendMessage({ type: "getSelection", API_BASE }, (resp) => {
      if (resp?.data)
        setStatus(`Selected: ${resp.data.name || resp.data.email || ""}`);
    });
  }

  document
    .getElementById("btnGetNumber")
    .addEventListener("click", async () => {
      chrome.runtime.sendMessage({ type: "getNumber", API_BASE }, (resp) => {
        if (resp?.success) {
          document.getElementById(
            "numberDisplay"
          ).innerText = `Number: ${resp.number}`;
        } else {
          alert(resp?.error || "Failed to get number");
        }
      });
    });

  document
    .getElementById("btnFillPhone")
    .addEventListener("click", async () => {
      const data = await chrome.storage.local.get([
        "country",
        "countryCode",
        "number",
        "id",
      ]);
      if (!data.number || !data.country) {
        alert("No phone data found. Please fetch number first.");
        return;
      }

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        chrome.runtime.sendMessage(
          {
            type: "fillPhoneForm",
            tabId: tabs[0].id,
            data,
          },
          (resp) => {
            if (resp?.success) alert("✅ Phone form filled successfully!");
            else alert(resp?.error || "❌ Failed to fill form");
          }
        );
      });
    });

  // FILL ADDRESS
  document.getElementById("btnFillAddress")?.addEventListener("click", () => {
    // Try to use selected data from the list; fallback to example values
    chrome.runtime.sendMessage({ type: "getSelection" }, (resp) => {
      const sel = resp?.data || {};
      const bdate = sel.dob.split("T")[0].split("-");
      console.log(`${bdate[1]}/${bdate[2]}/${bdate[0]}`);
      const address = {
        fullName: sel.fullName || sel.name || "John Doe",
        country: sel.country || "Indonesia",
        countryCode: sel.countryCode || "ID",
        postalCode: sel.postCode || sel.zip || "40115",
        state: sel.state || sel.region || sel.province || "Jawa Barat",
        city: sel.city || "Bandung",
        address1:
          sel.address || sel.addressLine1 || sel.street || "Jl. Merdeka No. 1",
        dob: `${bdate[1]}/${bdate[2]}/${bdate[0]}`,
        phone: sel.phone || sel.phoneNumber || "081234567890",
      };

      console.log(address);

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          setStatus("No active tab");
          return;
        }
        chrome.runtime.sendMessage(
          { type: "injectFillAddress", tabId, data: address },
          (r) => {
            setStatus(
              r?.success
                ? "Address fields filled"
                : "Fill address failed: " + (r?.error || "")
            );
          }
        );
      });
    });
  });

  // FILL BANK
  document.getElementById("btnFillBank")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "getSelection" }, (resp) => {
      const sel = resp?.data || {};
      if (!sel) {
        setStatus("No data selected");
        return;
      }
      // Prepare fields for bank form
      let dob = sel.dob;
      try {
        if (dob && dob.includes("T")) {
          const parts = dob.split("T")[0].split("-");
          dob = `${parts[1]}/${parts[2]}/${parts[0]}`; // MM/DD/YYYY
        }
      } catch (_) {}

      const payload = {
        accNum: sel.accNum || sel.accountNumber || "",
        bicCode: sel.bicCode || sel.swift || "",
        accountHolderName: sel.accountHolderName || sel.fullName || sel.name || "",
        dob: dob || sel.dob || "",
      };

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tabId = tabs?.[0]?.id;
        if (!tabId) {
          setStatus("No active tab");
          return;
        }
        chrome.runtime.sendMessage(
          { type: "injectFillBank", tabId, data: payload },
          (r) => {
            setStatus(r?.success ? "Bank form filled" : `Fill bank failed: ${r?.error || ""}`);
          }
        );
      });
    });
  });

  document.getElementById("btnGetCode").addEventListener("click", async () => {
    const { token, id } = await chrome.storage.local.get(["token", "id"]);

    if (!token) {
      alert("Please log in first!");
      return;
    }
    if (!id) {
      alert("No number ID found! Get a number first.");
      return;
    }

    try {
      // 👉 Update this URL to your actual API endpoint
      const response = await fetch(`${API_BASE}/api/number/message/${id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) throw new Error("Failed to fetch code");

      const { data } = await response.json();
      console.log(data);

      if (!data.code.code) throw new Error("No code returned from server");

      // Save code to storage
      await chrome.storage.local.set({ code: data.code.code });

      alert(`✅ Code received and saved: ${data.code.code}`);
    } catch (err) {
      console.error(err);
      alert(`❌ Error: ${err.message}`);
    }
  });

  document.getElementById("btnFillCode").addEventListener("click", async () => {
    const { code } = await chrome.storage.local.get("code");
    if (!code) return alert("No code saved!");

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.runtime.sendMessage({
        type: "fillCode",
        tabId: tabs[0].id,
        data: { code },
      });
    });
  });

  checkAuth();
});
