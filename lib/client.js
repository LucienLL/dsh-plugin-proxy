/**
 * dsh-plugin-proxy — browser face.
 *
 * Two contributions:
 * 1. A persistent proxy switch at the sidebar foot (`sidebar.footer.action`)
 *    — always visible, toggles the master `enabled` switch live.
 * 2. A settings card under the Plugins settings tab (`settings.plugin.item`,
 *    keyed by the `proxy` namespace) — mode (system proxy / custom address /
 *    none), custom URL, bypass list, and the master switch.
 *
 * Both read and write the `proxy` settings namespace through the shared
 * `ctx.settingsScope` transport; the host applies changes immediately.
 *
 * EXPERIMENTAL: this hand-written module mirrors the loader format emitted by
 * the in-repo client bundles (window.__ModuleLoader__.load with a CommonJS
 * factory). It is served to the browser on demand via the client-modules
 * roster (/plugins/<id>/client.js) when this package's composition row is
 * mounted on a web profile. React is required through the app's module table;
 * no JSX, no bundler, no TS.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-proxy/client",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var useSyncExternalStore = react.useSyncExternalStore;

    var cssId = "dsh-plugin-proxy/client";
    var css = [
      ".dsppx{--dshpx-accent:#4d6bfe}",
      ".dsppx-toggle{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:6px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;border-radius:8px;text-align:left}",
      ".dsppx-toggle:hover{background:var(--dsw-alias-bg-layer-1)}",
      ".dsppx-toggle[data-active=true]{background:var(--dsw-alias-bg-layer-1)}",
      ".dsppx-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-error-primary)}",
      ".dsppx-toggle[data-active=true] .dsppx-dot{background:var(--dsw-alias-state-success-primary)}",
      ".dsppx-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}",
      ".dsppx-switch{position:relative;flex:none;width:30px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l1);transition:background .15s ease}",
      ".dsppx-toggle[data-active=true] .dsppx-switch{background:var(--dshpx-accent)}",
      ".dsppx-switch::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s ease}",
      ".dsppx-toggle[data-active=true] .dsppx-switch::after{transform:translateX(12px)}",
      ".dsppx-toggle:disabled{opacity:.5;cursor:not-allowed}",
      ".dsppx-card{display:flex;flex-direction:column;gap:12px}",
      ".dsppx-field{display:flex;flex-direction:column;gap:4px}",
      ".dsppx-field>label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}",
      ".dsppx-field input,.dsppx-field select{box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}",
      ".dsppx-field input:disabled,.dsppx-field select:disabled{opacity:.5}",
      ".dsppx-hint{font-size:11px;color:var(--dsw-alias-label-caption)}",
      ".dsppx-row{display:flex;align-items:center;gap:10px}",
      ".dsppx-row .dsppx-dot{width:10px;height:10px}",
      ".dsppx-rowlabel{font-size:13px;font-weight:500;flex:1;color:var(--dsw-alias-label-primary)}",
    ].join("");
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + cssId + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-proxy";
      tag.dataset.pluginCss = cssId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /**
     * Read the `proxy` namespace snapshot reactively.
     * @param scope - the bound SettingsScope.
     * @returns `{ value, writable, ready }`.
     */
    function useProxySnapshot(scope) {
      var snapshot = useSyncExternalStore(
        function (onChange) { return scope.subscribe(onChange); },
        function () { return scope.getSnapshot(); }
      );
      var ready = snapshot.status === "ready" && snapshot.value !== undefined;
      return {
        value: ready ? snapshot.value : undefined,
        writable: snapshot.writable === true && ready,
        ready: snapshot.status === "unavailable" ? false : snapshot.status === "ready",
      };
    }

    /**
     * The persistent switch at the sidebar foot. Wide sidebar: label + status
     * dot + switch. Collapsed rail: the switch alone.
     */
    function ProxyToggleRow(props) {
      var wide = props.wide !== false;
      var state = useProxySnapshot(props.scope);
      var active = !!(state.value && state.value.enabled);
      function toggle() {
        if (!state.writable) return;
        props.scope.set("enabled", !active).catch(function (error) {
          console.error("[dsh-plugin-proxy] toggle failed:", error);
        });
      }
      return react.createElement(
        "button",
        {
          type: "button",
          className: "dsppx-toggle",
          "data-active": active ? "true" : undefined,
          "data-proxy-toggle": true,
          onClick: toggle,
          disabled: !state.writable,
          title: active ? "代理已开启（点击关闭）" : "代理已关闭（点击开启）",
          "aria-pressed": active,
        },
        react.createElement("span", { className: "dsppx-dot" }),
        wide
          ? react.createElement("span", { className: "dsppx-label" }, active ? "代理 · 已开启" : "代理 · 已关闭")
          : null,
        react.createElement("span", { className: "dsppx-switch" })
      );
    }

    /**
     * The settings card under Settings → Plugins → Proxy. Fields write
     * immediately (live apply): the master switch, the address source, the
     * custom URL, and the NO_PROXY bypass list.
     */
    function ProxySettingsCard(props) {
      var state = useProxySnapshot(props.scope);
      if (!state.ready) {
        return react.createElement(
          "div",
          { className: "dsppx-card", "data-proxy-settings": true },
          react.createElement("p", { className: "dsppx-hint" }, "代理设置加载中…")
        );
      }
      var value = state.value || { enabled: false, mode: "system", customUrl: "", noProxy: "" };
      function setField(field) {
        return function (event) {
          var next = event.target.type === "checkbox" ? event.target.checked : event.target.value;
          props.scope.set(field, next).catch(function (error) {
            console.error("[dsh-plugin-proxy] save failed:", error);
          });
        };
      }
      var mode = value.mode === "none" || value.mode === "custom" ? value.mode : "system";
      var active = value.enabled === true && mode !== "none";
      return react.createElement(
        "div",
        { className: "dsppx-card", "data-proxy-settings": true },
        react.createElement(
          "div",
          { className: "dsppx-row" },
          react.createElement("span", { className: "dsppx-dot", "data-on": active ? "true" : undefined, style: { background: active ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)" } }),
          react.createElement("span", { className: "dsppx-rowlabel" }, active ? "代理生效中（模型请求与工具流量均走代理）" : "代理未生效（直连）"),
          react.createElement(
            "label",
            { className: "dsppx-switch", style: { display: "inline-block", cursor: state.writable ? "pointer" : "not-allowed" } },
            react.createElement("input", {
              type: "checkbox",
              checked: value.enabled === true,
              disabled: !state.writable,
              onChange: setField("enabled"),
              style: { position: "absolute", opacity: 0, width: 0, height: 0 },
            })
          )
        ),
        react.createElement(
          "div",
          { className: "dsppx-field" },
          react.createElement("label", { htmlFor: "dsppx-mode" }, "代理地址来源"),
          react.createElement(
            "select",
            { id: "dsppx-mode", value: mode, disabled: !state.writable, onChange: setField("mode") },
            react.createElement("option", { value: "system" }, "使用系统代理（Windows 设置）"),
            react.createElement("option", { value: "custom" }, "自定义地址"),
            react.createElement("option", { value: "none" }, "不使用代理")
          ),
          react.createElement("span", { className: "dsppx-hint" },
            mode === "system" ? "读取 Windows 的“Internet 设置”中的代理（开关关闭时系统代理也不生效）。"
              : mode === "custom" ? "使用下方自定义地址。" : "即使开关开启也不走代理。")
        ),
        mode === "custom"
          ? react.createElement(
            "div",
            { className: "dsppx-field" },
            react.createElement("label", { htmlFor: "dsppx-url" }, "自定义代理地址"),
            react.createElement("input", {
              id: "dsppx-url",
              type: "text",
              value: value.customUrl || "",
              placeholder: "http://127.0.0.1:7890",
              disabled: !state.writable,
              onBlur: setField("customUrl"),
            }),
            react.createElement("span", { className: "dsppx-hint" }, "支持 http:// 或 https:// 开头的地址，例如 http://127.0.0.1:7890。")
          )
          : null,
        react.createElement(
          "div",
          { className: "dsppx-field" },
          react.createElement("label", { htmlFor: "dsppx-noproxy" }, "直连名单（NO_PROXY）"),
          react.createElement("input", {
            id: "dsppx-noproxy",
            type: "text",
            value: value.noProxy || "",
            placeholder: "localhost,127.0.0.1,::1",
            disabled: !state.writable,
            onBlur: setField("noProxy"),
          }),
          react.createElement("span", { className: "dsppx-hint" }, "逗号分隔的主机名；localhost / 127.0.0.1 / ::1 始终直连。此处列出的目标即使代理开启也直接访问。")
        ),
        react.createElement("span", { className: "dsppx-hint" },
          "对话中的模型会实时感知代理状态（系统提示中标注），并可用 proxy_status / proxy_set 查询或临时切换。")
      );
    }

    /**
     * Browser plugin body: bind the `proxy` settings scope, then register the
     * persistent sidebar switch and the settings card.
     * @param ctx - client cordis context.
     */
    function apply(ctx) {
      var scope = ctx.settingsScope.bind({ namespace: "proxy" });
      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register({
          name: "sidebar.footer.action",
          id: "proxy-toggle",
          order: 10,
        }, function ToggleRow(props) {
          return react.createElement(ProxyToggleRow, { scope: scope, wide: props.wide !== false });
        });
      });
      ctx.slots.inject("settings.plugin.item", function () {
        return ctx.slots.register({
          name: "settings.plugin.item",
          key: "proxy",
        }, function SettingsCard() {
          return react.createElement(ProxySettingsCard, { scope: scope });
        });
      });
    }

    exports.name = "proxy-ui";
    exports.apply = apply;
    // Cordis service names the browser loader must wait for — NOT package
    // names (those belong in package.json's dsh.client.inject). Writing
    // package names here keeps the plugin permanently pending and blocks
    // web boot. See docs/LESSONS.md and test/client-shape.mjs.
    exports.inject = [
      "slots",
      "settingsScope",
    ];
    return module.exports;
  },
});
