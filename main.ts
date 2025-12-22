import { Notice, Plugin } from "obsidian";
import http, { IncomingMessage, ServerResponse } from "http";

type Point = { x: number; y: number };
type PointPair = [number, number];

type ServerElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontFamily?: string | number;
  points?: Point[];
  startArrowhead?: string | null;
  endArrowhead?: string | null;
};

type ViewElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  points?: Point[];
  text?: string;
  backgroundColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  fontSize?: number;
  fontFamily?: string | number;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
};

interface BridgeSettings {
  serverEnabled: boolean;
  serverHost: string;
  serverPort: number;
}

const DEFAULT_SETTINGS: BridgeSettings = {
  serverEnabled: true,
  serverHost: "127.0.0.1",
  serverPort: 3030,
};

export default class McpExcalidrawBridgeDemo extends Plugin {
  private settings: BridgeSettings = DEFAULT_SETTINGS;
  private proxyServer: http.Server | null = null;
  private elements = new Map<string, ServerElement>();

  async onload() {
    await this.loadSettings();

    this.startProxyServer();
  }

  onunload() {
    this.stopProxyServer();
  }

  private async loadSettings() {
    const loaded = (await this.loadData()) as Partial<BridgeSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  }

  private getTargetExcalidrawView(): any | null {
    const activeLeaf = this.app.workspace.getActiveLeaf();
    const activeView = activeLeaf?.view as any;
    if (activeView?.getViewType && activeView.getViewType() === "excalidraw") {
      return activeView;
    }

    const leaves = this.app.workspace.getLeavesOfType("excalidraw");
    return leaves.length > 0 ? (leaves[0].view as any) : null;
  }

  private getEA(view: any): any | null {
    const eaGlobal = (window as any).ExcalidrawAutomate;
    if (!eaGlobal || typeof eaGlobal.getAPI !== "function") {
      return null;
    }
    return eaGlobal.getAPI(view);
  }

  private getExcalidrawPlugin(): any | null {
    const plugins = (this.app as any).plugins;
    if (!plugins?.getPlugin) return null;
    return plugins.getPlugin("obsidian-excalidraw-plugin") ?? null;
  }

  private async getViewForWrite(silent: boolean, allowCreate: boolean = false): Promise<any | null> {
    let view = this.getTargetExcalidrawView();
    if (view) return view;

    if (!allowCreate) {
      if (!silent) new Notice("No active Excalidraw view");
      return null;
    }

    const excalidrawPlugin = this.getExcalidrawPlugin();
    const excalidrawAutomate = excalidrawPlugin?.ea;
    if (!excalidrawAutomate?.create) {
      if (!silent) new Notice("Excalidraw plugin not available");
      return null;
    }

    try {
      await excalidrawAutomate.create({ silent: false, onNewPane: false });
    } catch (error) {
      console.error("Create new Excalidraw drawing failed", error);
      if (!silent) new Notice("Failed to create new Excalidraw drawing");
      return null;
    }

    view = this.getTargetExcalidrawView();
    if (!view && !silent) {
      new Notice("No active Excalidraw view");
    }
    return view;
  }

  private applyStyle(ea: any, element: ServerElement) {
    if (!ea?.style) return;

    if (element.strokeColor) ea.style.strokeColor = element.strokeColor;
    if (element.backgroundColor) ea.style.backgroundColor = element.backgroundColor;
    if (typeof element.strokeWidth === "number") ea.style.strokeWidth = element.strokeWidth;
    if (typeof element.roughness === "number") ea.style.roughness = element.roughness;
    if (typeof element.opacity === "number") ea.style.opacity = element.opacity;
    if (typeof element.fontSize === "number") ea.style.fontSize = element.fontSize;

    if (typeof element.fontFamily !== "undefined") {
      const family = Number(element.fontFamily);
      if (!Number.isNaN(family) && typeof ea.setFontFamily === "function") {
        ea.setFontFamily(family);
      } else if (!Number.isNaN(family)) {
        ea.style.fontFamily = family;
      }
    }
  }

  private pointsToPairs(points?: Point[]): [number, number][] {
    if (!points || points.length === 0) return [[0, 0], [0, 0]];
    if (Array.isArray(points[0])) {
      return points as PointPair[];
    }
    return (points as Point[]).map((p) => [p.x, p.y]);
  }

  private async applyCreate(element: ServerElement, silent: boolean = false) {
    const view = await this.getViewForWrite(silent, true);
    if (!view) return;

    const ea = this.getEA(view);
    if (!ea) {
      if (!silent) new Notice("Excalidraw Automate API not available");
      return;
    }

    ea.reset();
    this.applyStyle(ea, element);

    switch (element.type) {
      case "rectangle":
        ea.addRect(element.x, element.y, element.width ?? 100, element.height ?? 60, element.id);
        break;
      case "ellipse":
        ea.addEllipse(element.x, element.y, element.width ?? 100, element.height ?? 60, element.id);
        break;
      case "diamond":
        ea.addDiamond(element.x, element.y, element.width ?? 100, element.height ?? 60, element.id);
        break;
      case "text":
        ea.addText(element.x, element.y, element.text ?? "", undefined, element.id);
        break;
      case "arrow":
        ea.addArrow(this.pointsToPairs(element.points), {
          startArrowHead: element.startArrowhead ?? undefined,
          endArrowHead: element.endArrowhead ?? undefined,
        }, element.id);
        break;
      case "line":
        ea.addLine(this.pointsToPairs(element.points), element.id);
        break;
      default:
        console.warn("Unsupported element type", element.type);
        ea.destroy();
        return;
    }

    await ea.addElementsToView(false, true, true);
    ea.destroy();
    this.elements.set(element.id, element);
  }

  private async applyUpdate(element: ServerElement, silent: boolean = false) {
    const view = await this.getViewForWrite(silent);
    if (!view) return;

    const ea = this.getEA(view);
    if (!ea) return;

    const existing = ea.getViewElements().find((el: any) => el.id === element.id);
    if (existing) {
      ea.deleteViewElements([existing]);
    }

    ea.destroy();
    await this.applyCreate(element, silent);
  }

  private async applyDelete(elementId: string, silent: boolean = false) {
    const view = await this.getViewForWrite(silent);
    if (!view) return;

    const ea = this.getEA(view);
    if (!ea) return;

    const existing = ea.getViewElements().find((el: any) => el.id === elementId);
    if (existing) {
      ea.deleteViewElements([existing]);
    }

    ea.destroy();
    this.elements.delete(elementId);
  }

  private getElementsFromView(view: any): ServerElement[] {
    const ea = this.getEA(view);
    if (!ea) return [];
    const elements = ea.getViewElements() as ViewElement[];
    ea.destroy();
    return elements.map((element) => ({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      points: element.points,
      text: element.text,
      backgroundColor: element.backgroundColor,
      strokeColor: element.strokeColor,
      strokeWidth: element.strokeWidth,
      roughness: element.roughness,
      opacity: element.opacity,
      fontSize: element.fontSize,
      fontFamily: element.fontFamily,
      startArrowhead: element.startArrowhead,
      endArrowhead: element.endArrowhead,
    }));
  }

  private startProxyServer() {
    if (!this.settings.serverEnabled) return;
    if (this.proxyServer) return;

    this.proxyServer = http.createServer((req, res) => {
      this.handleProxyRequest(req, res);
    });

    this.proxyServer.listen(this.settings.serverPort, this.settings.serverHost, () => {
      new Notice(`Bridge proxy server listening on ${this.settings.serverHost}:${this.settings.serverPort}`);
    });
  }

  private stopProxyServer() {
    if (this.proxyServer) {
      this.proxyServer.close();
      this.proxyServer = null;
    }
  }

  private async handleProxyRequest(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", `http://${this.settings.serverHost}:${this.settings.serverPort}`);
      const { pathname } = url;
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" && pathname === "/api/elements") {
        const view = await this.getViewForWrite(true);
        if (view) {
          const viewElements = this.getElementsFromView(view);
          return this.sendJson(res, 200, {
            success: true,
            elements: viewElements,
            count: viewElements.length,
          });
        }
        return this.sendJson(res, 200, {
          success: true,
          elements: Array.from(this.elements.values()),
          count: this.elements.size,
        });
      }

      if (method === "GET" && pathname === "/api/sync/status") {
        return this.sendJson(res, 200, {
          success: true,
          count: this.elements.size,
          timestamp: new Date().toISOString(),
        });
      }

      if (method === "GET" && pathname.startsWith("/api/elements/")) {
        const id = pathname.split("/").pop() ?? "";
        const view = await this.getViewForWrite(true);
        if (view) {
          const viewElements = this.getElementsFromView(view);
          const element = viewElements.find((item) => item.id === id);
          if (!element) {
            return this.sendJson(res, 404, { success: false, error: "Element not found" });
          }
          return this.sendJson(res, 200, { success: true, element });
        }
        const element = this.elements.get(id);
        if (!element) {
          return this.sendJson(res, 404, { success: false, error: "Element not found" });
        }
        return this.sendJson(res, 200, { success: true, element });
      }

      if (method === "POST" && pathname === "/api/elements") {
        const body = await this.readJson(req);
        const element = this.normalizeElement(body);
        this.elements.set(element.id, element);
        await this.applyCreate(element, true);
        return this.sendJson(res, 200, { success: true, element });
      }

      if (method === "PUT" && pathname.startsWith("/api/elements/")) {
        const id = pathname.split("/").pop() ?? "";
        const body = await this.readJson(req);
        const existing = this.elements.get(id);
        if (!existing) {
          return this.sendJson(res, 404, { success: false, error: "Element not found" });
        }
        const updated = { ...existing, ...body, id };
        this.elements.set(id, updated);
        await this.applyUpdate(updated, true);
        return this.sendJson(res, 200, { success: true, element: updated });
      }

      if (method === "DELETE" && pathname.startsWith("/api/elements/")) {
        const id = pathname.split("/").pop() ?? "";
        if (!this.elements.has(id)) {
          return this.sendJson(res, 404, { success: false, error: "Element not found" });
        }
        this.elements.delete(id);
        await this.applyDelete(id, true);
        return this.sendJson(res, 200, { success: true });
      }

      if (method === "POST" && pathname === "/api/elements/batch") {
        const body = await this.readJson(req);
        const elements = Array.isArray(body?.elements) ? body.elements : [];
        const processed: ServerElement[] = [];
        for (const element of elements) {
          const normalized = this.normalizeElement(element);
          this.elements.set(normalized.id, normalized);
          processed.push(normalized);
          await this.applyCreate(normalized, true);
        }
        return this.sendJson(res, 200, { success: true, elements: processed, count: processed.length });
      }

      if (method === "POST" && pathname === "/api/elements/sync") {
        const body = await this.readJson(req);
        const elements = Array.isArray(body?.elements) ? body.elements : [];
        this.elements.clear();
        const processed: ServerElement[] = [];
        for (const element of elements) {
          const normalized = this.normalizeElement(element);
          this.elements.set(normalized.id, normalized);
          processed.push(normalized);
          await this.applyUpdate(normalized, true);
        }
        return this.sendJson(res, 200, { success: true, count: processed.length });
      }

      return this.sendJson(res, 404, { success: false, error: "Not found" });
    } catch (error) {
      console.error("Proxy server error", error);
      return this.sendJson(res, 500, { success: false, error: "Internal error" });
    }
  }

  private async readJson(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const data = Buffer.concat(chunks).toString("utf8");
    return data ? JSON.parse(data) : {};
  }

  private normalizeElement(raw: any): ServerElement {
    const id = typeof raw?.id === "string" ? raw.id : `bridge-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return { ...raw, id } as ServerElement;
  }

  private sendJson(res: ServerResponse, status: number, payload: any) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  }
}
