use tauri::{Emitter, Manager};

/**
 * THE NATIVE SHELL.
 *
 * This process owns windows, a keyboard shortcut and nothing else. It holds no credentials, talks to
 * no broker, evaluates no strategy and makes no decision that could reach an order — all of that lives
 * on the server, where it keeps running when this computer sleeps, crashes or is thrown in a bag.
 * A desktop application that could take a position would be a desktop application whose crash could
 * lose one.
 *
 * It does not embed a frontend either. The windows load the deployed Command Center over https, which
 * is what lets the member's existing session, the API routes and the voice socket work with no second
 * implementation of any of them. Tauri injects its IPC bridge into those pages, but the Rust side
 * answers only what `capabilities/remote-command-center.json` allows — window geometry, focus and
 * notifications. No filesystem, no shell, no process control.
 */

/// The shortcut is registered HERE rather than from the page.
///
/// Doing it in JavaScript would mean granting a remote origin the ability to register system-wide key
/// bindings, which is a capability worth considerably more to an attacker than anything else in this
/// application. The trade-off is that the binding is fixed until the member can configure it through a
/// command we expose deliberately — a smaller surface than handing over the whole plugin.
#[cfg(desktop)]
const TOGGLE_COMPANION: &str = "Alt+Space";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // The companion's geometry is its own business — it is resized by the page as its
                // content changes, and restoring yesterday's height over today's content is worse
                // than simply opening where it was told to.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Builder as Shortcuts, ShortcutState};

                let handle = app.handle().clone();
                app.handle().plugin(
                    Shortcuts::new()
                        .with_handler(move |_app, _shortcut, event| {
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }
                            let Some(w) = handle.get_webview_window("companion") else { return };
                            // Bring it forward and tell the page, so it can open the line and start
                            // listening in the same gesture. Siri's trick: one key, ready to talk.
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.emit("companion://summoned", ());
                        })
                        .build(),
                )?;

                if let Ok(shortcut) = TOGGLE_COMPANION.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    // A shortcut another application already owns is a conflict, not a crash.
                    let _ = app.global_shortcut().register(shortcut);
                }
            }

            /*
             * The companion is what opens, and the Command Center waits behind it.
             *
             * Section 24 of the specification: THE BRAIN appears first. The full application is created
             * hidden so that "open Command Center" is a window being raised — instantly, already holding
             * the session and the current market state — rather than a cold start.
             */
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.hide();
            }

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Command Center shell");
}
