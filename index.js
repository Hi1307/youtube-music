"use strict";
const path = require("path");

const electron = require("electron");
const enhanceWebRequest = require("electron-better-web-request").default;
const is = require("electron-is");
const unhandled = require("electron-unhandled");
const { autoUpdater } = require("electron-updater");

const config = require("./config");
const { setApplicationMenu } = require("./menu");
const { fileExists, injectCSS } = require("./plugins/utils");
const { isTesting } = require("./utils/testing");
const { setUpTray } = require("./tray");
const { setupSongInfo } = require("./providers/song-info");

// Catch errors and log them
unhandled({
	logger: console.error,
	showDialog: false,
});

const app = electron.app;
app.commandLine.appendSwitch(
	"js-flags",
	// WebAssembly flags
	"--experimental-wasm-threads --experimental-wasm-bulk-memory"
);
app.allowRendererProcessReuse = true; // https://github.com/electron/electron/issues/18397
if (config.get("options.disableHardwareAcceleration")) {
	if (is.dev()) {
		console.log("Disabling hardware acceleration");
	}
	app.disableHardwareAcceleration();
}

if (config.get("options.proxy")) {
	app.commandLine.appendSwitch("proxy-server", config.get("options.proxy"));
}

// Adds debug features like hotkeys for triggering dev tools and reload
require("electron-debug")();

// Prevent window being garbage collected
let mainWindow;
autoUpdater.autoDownload = false;

let icon = "assets/youtube-music.png";
if (process.platform == "win32") {
	icon = "assets/generated/icon.ico";
} else if (process.platform == "darwin") {
	icon = "assets/generated/icon.icns";
}

function onClosed() {
	// Dereference the window
	// For multiple windows store them in an array
	mainWindow = null;
}

function loadPlugins(win) {
	injectCSS(win.webContents, path.join(__dirname, "youtube-music.css"));
	win.webContents.on("did-finish-load", () => {
		if (is.dev()) {
			console.log("did finish load");
			win.webContents.openDevTools();
		}
	});

	config.plugins.getEnabled().forEach(([plugin, options]) => {
		console.log("Loaded plugin - " + plugin);
		const pluginPath = path.join(__dirname, "plugins", plugin, "back.js");
		fileExists(pluginPath, () => {
			const handle = require(pluginPath);
			handle(win, options);
		});
	});
}

function createMainWindow() {
	const windowSize = config.get("window-size");
	const windowMaximized = config.get("window-maximized");
	const windowPosition = config.get("window-position");
	const useInlineMenu = config.plugins.isEnabled("in-app-menu");

	const win = new electron.BrowserWindow({
		icon: icon,
		width: windowSize.width,
		height: windowSize.height,
		backgroundColor: "#000",
		show: false,
		webPreferences: {
			// TODO: re-enable contextIsolation once it can work with ffmepg.wasm
			// Possible bundling? https://github.com/ffmpegwasm/ffmpeg.wasm/issues/126
			contextIsolation: false,
			preload: path.join(__dirname, "preload.js"),
			nodeIntegrationInSubFrames: true,
			nativeWindowOpen: true, // window.open return Window object(like in regular browsers), not BrowserWindowProxy
			enableRemoteModule: true,
			affinity: "main-window", // main window, and addition windows should work in one process
			...(isTesting()
				? {
					// Only necessary when testing with Spectron
					contextIsolation: false,
					nodeIntegration: true,
				}
				: undefined),
		},
		frame: !is.macOS() && !useInlineMenu,
		titleBarStyle: useInlineMenu
			? "hidden"
			: is.macOS()
			? "hiddenInset"
			: "default",
		autoHideMenuBar: config.get("options.hideMenu"),
	});
	if (windowPosition) {
		const { x, y } = windowPosition;
		win.setPosition(x, y);
	}
	if (windowMaximized) {
		win.maximize();
	}

	const urlToLoad = config.get("options.resumeOnStart")
		? config.get("url")
		: config.defaultConfig.url;
	win.webContents.loadURL(urlToLoad);
	win.on("closed", onClosed);

	win.on("move", () => {
		let position = win.getPosition();
		config.set("window-position", { x: position[0], y: position[1] });
	});

	win.on("resize", () => {
		const windowSize = win.getSize();

		config.set("window-maximized", win.isMaximized());
		if (!win.isMaximized()) {
			config.set("window-size", {
				width: windowSize[0],
				height: windowSize[1],
			});
		}
	});

	win.webContents.on("render-process-gone", (event, webContents, details) => {
		showUnresponsiveDialog(win, details);
	});

	win.once("ready-to-show", () => {
		if (config.get("options.appVisible")) {
			win.show();
		}
	});

	removeContentSecurityPolicy();

	return win;
}

app.once("browser-window-created", (event, win) => {
	setupSongInfo(win);
	loadPlugins(win);

	win.webContents.on("did-fail-load", (
		_event,
		errorCode,
		errorDescription,
		validatedURL,
		isMainFrame,
		frameProcessId,
		frameRoutingId,
	) => {
		const log = JSON.stringify({
			error: "did-fail-load",
			errorCode,
			errorDescription,
			validatedURL,
			isMainFrame,
			frameProcessId,
			frameRoutingId,
		}, null, "\t");
		if (is.dev()) {
			console.log(log);
		}
		if( !(config.plugins.isEnabled("in-app-menu") && errorCode === -3)) { // -3 is a false positive with in-app-menu
			win.webContents.send("log", log);
			win.webContents.loadFile(path.join(__dirname, "error.html"));
		}
	});

	win.webContents.on("will-prevent-unload", (event) => {
		event.preventDefault();
	});

	win.webContents.on("did-navigate-in-page", () => {
		const url = win.webContents.getURL();
		if (url.startsWith("https://music.youtube.com")) {
			config.set("url", url);
		}
	});

	win.webContents.on("will-navigate", (_, url) => {
		if (url.startsWith("https://accounts.google.com")) {
			// Force user-agent "Firefox Windows" for Google OAuth to work
			// From https://github.com/firebase/firebase-js-sdk/issues/2478#issuecomment-571356751
			// Only set on accounts.google.com, otherwise querySelectors in preload scripts fail (?)
			// Uses custom user agent to Google alert with a correct device type (https://github.com/th-ch/youtube-music/issues/327)
			// User agents are from https://developers.whatismybrowser.com/useragents/explore/
			const userAgents = {
				mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.14; rv:70.0) Gecko/20100101 Firefox/70.0",
				windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0",
				linux: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:90.0) Gecko/20100101 Firefox/90.0",
			}
			
			const userAgent = 
				is.macOS() ? userAgents.mac :
				is.windows() ? userAgents.windows :
				userAgents.linux;

			win.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
				details.requestHeaders["User-Agent"] = userAgent;
				cb({ requestHeaders: details.requestHeaders });
			});
		}
	});

	win.webContents.on(
		"new-window",
		(e, url, frameName, disposition, options) => {
			// hook on new opened window

			// at now new window in mainWindow renderer process.
			// Also, this will automatically get an option `nodeIntegration=false`(not override to true, like in iframe's) - like in regular browsers
			options.webPreferences.affinity = "main-window";
		}
	);
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}

	// Unregister all shortcuts.
	electron.globalShortcut.unregisterAll();
});

app.on("activate", () => {
	// On OS X it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	if (mainWindow === null) {
		mainWindow = createMainWindow();
	} else if (!mainWindow.isVisible()) {
		mainWindow.show();
	}
});

app.on("ready", () => {
	if (config.get("options.autoResetAppCache")) {
		// Clear cache after 20s
		const clearCacheTimeout = setTimeout(() => {
			if (is.dev()) {
				console.log("Clearing app cache.");
			}
			electron.session.defaultSession.clearCache();
			clearTimeout(clearCacheTimeout);
		}, 20000);
	}

	// Register appID on windows
	if (is.windows()) {
		const appID = "com.github.th-ch.youtube-music";
		app.setAppUserModelId(appID);
		const appLocation = process.execPath;
		const appData = app.getPath("appData");
		// check shortcut validity if not in dev mode / running portable app
		if (!is.dev() && !appLocation.startsWith(path.join(appData, "..", "Local", "Temp"))) {
			const shortcutPath = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "YouTube Music.lnk");
			try { // check if shortcut is registered and valid
				const shortcutDetails = electron.shell.readShortcutLink(shortcutPath); // throw error if doesn't exist yet
				if (shortcutDetails.target !== appLocation || shortcutDetails.appUserModelId !== appID) {
					throw "needUpdate";
				}
			} catch (error) { // if not valid -> Register shortcut
				electron.shell.writeShortcutLink(
					shortcutPath,
					error === "needUpdate" ? "update" : "create",
					{
						target: appLocation,
						cwd: appLocation.slice(0, appLocation.lastIndexOf(path.sep)),
						description: "YouTube Music Desktop App - including custom plugins",
						appUserModelId: appID
					}
				);
			}
		}
	}

	mainWindow = createMainWindow();
	setApplicationMenu(mainWindow);
	if (config.get("options.restartOnConfigChanges")) {
		config.watch(() => {
			app.relaunch();
			app.exit();
		});
	}
	setUpTray(app, mainWindow);

	// Autostart at login
	app.setLoginItemSettings({
		openAtLogin: config.get("options.startAtLogin"),
	});

	if (!is.dev() && config.get("options.autoUpdates")) {
		const updateTimeout = setTimeout(() => {
			autoUpdater.checkForUpdatesAndNotify();
			clearTimeout(updateTimeout);
		}, 2000);
		autoUpdater.on("update-available", () => {
			const downloadLink =
				"https://github.com/th-ch/youtube-music/releases/latest";
			const dialogOpts = {
				type: "info",
				buttons: ["OK", "Download", "Disable updates"],
				title: "Application Update",
				message: "A new version is available",
				detail: `A new version is available and can be downloaded at ${downloadLink}`,
			};
			electron.dialog.showMessageBox(dialogOpts).then((dialogOutput) => {
				switch (dialogOutput.response) {
					// Download
					case 1:
						electron.shell.openExternal(downloadLink);
						break;
					// Disable updates
					case 2:
						config.set("options.autoUpdates", false);
						break;
					default:
						break;
				}
			});
		});
	}

	// Optimized for Mac OS X
	if (is.macOS() && !config.get("options.appVisible")) {
		app.dock.hide();
	}

	let forceQuit = false;
	app.on("before-quit", () => {
		forceQuit = true;
	});

	if (is.macOS() || config.get("options.tray")) {
		mainWindow.on("close", (event) => {
			// Hide the window instead of quitting (quit is available in tray options)
			if (!forceQuit) {
				event.preventDefault();
				mainWindow.hide();
			}
		});
	}
});

function showUnresponsiveDialog(win, details) {
	if (!!details) {
		console.log("Unresponsive Error!\n"+JSON.stringify(details, null, "\t"))
	}
	electron.dialog.showMessageBox(win, {
		type: "error",
		title: "Window Unresponsive",
		message: "The Application is Unresponsive",
		details: "We are sorry for the inconvenience! please choose what to do:",
		buttons: ["Wait", "Relaunch", "Quit"],
		cancelId: 0
	}).then( result => {
		switch (result.response) {
			case 1: //if relaunch - relaunch+exit
				app.relaunch();
			case 2:
				app.quit();
				break;
			default:
				break;
		}
	});
}

function removeContentSecurityPolicy(
	session = electron.session.defaultSession
) {
	// Allows defining multiple "onHeadersReceived" listeners
	// by enhancing the session.
	// Some plugins (e.g. adblocker) also define a "onHeadersReceived" listener
	enhanceWebRequest(session);

	// Custom listener to tweak the content security policy
	session.webRequest.onHeadersReceived(function (details, callback) {
		if (
			!details.responseHeaders["content-security-policy-report-only"] &&
			!details.responseHeaders["content-security-policy"]
		)
			return callback({ cancel: false });
		delete details.responseHeaders["content-security-policy-report-only"];
		delete details.responseHeaders["content-security-policy"];
		callback({ cancel: false, responseHeaders: details.responseHeaders });
	});

	// When multiple listeners are defined, apply them all
	session.webRequest.setResolver("onHeadersReceived", (listeners) => {
		const response = listeners.reduce(
			async (accumulator, listener) => {
				if (accumulator.cancel) {
					return accumulator;
				}

				const result = await listener.apply();
				return { ...accumulator, ...result };
			},
			{ cancel: false }
		);

		return response;
	});
}
