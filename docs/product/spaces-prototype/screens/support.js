class DCLogic {
  constructor() {
    this.state = {};
  }
  setState(p) {
    this.state = Object.assign({}, this.state, p);
    window.__dcRender();
  }
}
window.DCLogic = DCLogic;
document.addEventListener("DOMContentLoaded", () => {
  const host = document.querySelector("x-dc");
  const helmet = host.querySelector("helmet");
  if (helmet) {
    document.head.insertAdjacentHTML("beforeend", helmet.innerHTML);
    helmet.remove();
  }
  document.head.insertAdjacentHTML("beforeend", "<style>x-dc{display:block}</style>");
  const tpl = host.innerHTML;
  const src = document.querySelector("script[data-dc-script]").textContent;
  const Comp = new Function("DCLogic", src + "; return Component;")(DCLogic);
  const inst = new Comp();
  const m = location.hash.match(/state=([^&]+)/);
  inst.state = m ? JSON.parse(decodeURIComponent(m[1])) : {};
  window.__fns = {};
  window.__dcRender = () => {
    const vals = inst.renderVals() || {};
    host.innerHTML = tpl
      .replace(/\bonChange=/g, "oninput=")
      .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
        const v = vals[k];
        if (typeof v === "function") {
          window.__fns[k] = v;
          return "__fns." + k + "(event)";
        }
        return v === undefined ? "" : String(v).replace(/"/g, "&quot;");
      });
    host.querySelectorAll("sc-if").forEach((el) => {
      if (el.getAttribute("value") === "true") el.replaceWith(...el.childNodes);
      else el.remove();
    });
    host.querySelectorAll("textarea[value]").forEach((t) => {
      t.value = t.getAttribute("value");
    });
    ["disabled", "checked", "selected", "hidden"].forEach((a) =>
      host.querySelectorAll("[" + a + '="false"]').forEach((el) => el.removeAttribute(a)),
    );
    host.querySelectorAll("select[value]").forEach((el) => {
      el.value = el.getAttribute("value");
    });
  };
  window.__dcRender();
});
