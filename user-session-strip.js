document.addEventListener("DOMContentLoaded", () => {
  const userId = (localStorage.getItem("user_id") || "").trim();
  const userPhone = (localStorage.getItem("user_phone") || "").trim();

  if (!userId) {
    return;
  }

  const nav = document.querySelector(".kmc-header .kmc-nav");
  if (!nav) {
    return;
  }

  const existing = document.getElementById("userSessionStrip");
  if (existing) {
    return;
  }

  const loginBtn = nav.querySelector(".login-btn");

  const strip = document.createElement("div");
  strip.id = "userSessionStrip";
  strip.className = "user-session-strip";

  const account = document.createElement("span");
  account.className = "user-session-id";
  account.textContent = "Account ID: " + userId;

  const phone = document.createElement("span");
  phone.className = "user-session-phone";
  phone.textContent = userPhone ? "Phone: " + userPhone : "Logged In";

  const logout = document.createElement("button");
  logout.type = "button";
  logout.className = "user-session-logout";
  logout.textContent = "Logout";
  logout.addEventListener("click", () => {
    localStorage.removeItem("user_id");
    localStorage.removeItem("user_phone");
    localStorage.removeItem("application_id");
    localStorage.removeItem("application_code");
    window.location.href = "login.html";
  });

  strip.appendChild(account);
  strip.appendChild(phone);
  strip.appendChild(logout);

  if (loginBtn) {
    loginBtn.replaceWith(strip);
  } else {
    nav.appendChild(strip);
  }
});
