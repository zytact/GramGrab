# WhatsApp Visible Status live verification

An agent runs this procedure through the verify-gramgrab skill. It covers what synthetic tests
cannot establish: that current WhatsApp Web, the browser, and the built package still meet the
contract in [WhatsApp privacy constraints](./whatsapp-privacy.md). Synthetic tests remain
authoritative for every extension-owned boundary. [ADR 0010](./adr/0010-whatsapp-edits-like-other-media.md)
records why this is agent-run.

## Preconditions

1. Launch the harness with `.agents/skills/verify-gramgrab/scripts/launch.sh`. Its profile must have
   WhatsApp Web linked. `signin.sh` links it once.
2. Run `vp run verify:whatsapp-packages` against the build `launch.sh` made.
3. Open `https://web.whatsapp.com/`, wait for the chat list, then open the Status tab.
4. Pick Statuses from the linked account's feed on your own. Do not ask the account owner to post
   test cards.

## Which Statuses to capture

Capture a Status only when it shows no one from the account owner's own life. These are fine:

- reposted memes, reels, and screenshots of public posts
- places, objects, food, scenery, and text cards
- celebrities, influencers, and models in public content

Skip a Status that shows a private person, such as a friend, a relative, or the contact themself.
Screenshot the open viewer and look at it before capturing. If it is unclear, skip it and open the
next one. Opening a Status sends WhatsApp's normal view receipt, the same as opening it on a phone.

Pause a video Status before capturing so the viewer does not advance.

## Opening the popup on the WhatsApp tab

A popup opened as an ordinary tab is itself the active tab, so it can never reach WhatsApp. Open the
real toolbar popup on the WhatsApp tab with CDP `Extensions.triggerAction`, which grants `activeTab`
the same way a click on the toolbar icon does. The verify-gramgrab WhatsApp feature page has the
command.

## Matrix

| Scenario                              | Required result                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Photo Status                          | The isolated controller reads the foreground photo's page-owned `blob:` or same-origin source, transfers it over the frame-0 port, and the browser accepts one direct download. |
| Video Status                          | The isolated controller reads the active video player's source, not its poster, transfers it over the frame-0 port, and the browser accepts one direct download.                |
| Edit hero: photo and video            | The edit surface shows `Visible Status captured` and renders a photo as an image and an MP4 as a video in the single hero item, never a missing or poster-only preview.         |
| Shown scrub frame equals saved frame  | Enable `Frame` on a video and scrub to a non-zero timestamp. The preview seeks there, and the saved JPEG shows the same frame.                                                  |
| Rotate and crop a photo               | Rotate the photo once and crop it to 1:1. The saved JPEG is turned and has the crop's proportions.                                                                              |
| Crop a video                          | Crop a video to 1:1 and download. The saved MP4 has the crop's proportions and keeps its audio track. With `Remove audio` on, it has no audio track.                            |
| Rotate and crop a frame               | Rotate a video, crop it, enable `Frame`, and download. The saved JPEG is turned and cropped.                                                                                    |
| Muted export has no audio track       | Enable `Remove audio` on a video and download. The saved MP4 has a video track and no audio track.                                                                              |
| Advancement race                      | Advance or close the viewer while capture is acquiring. The result is either the originally guarded item or `WHATSAPP_STATUS_CHANGED`, never the next Status.                   |
| Cleanup after accepted download       | The popup releases the captured bytes and the extension-created blob URL once the download starts. Nothing hands the capture to the workspace or the service worker.            |
| Cleanup after cancellation or failure | Close the popup, the tab, or the viewer during capture. Bytes are discarded and any extension-created blob URL is revoked.                                                      |

The harness drives Chromium. Firefox parity is unproven until a harness drives it.

## Evidence

Save screenshots, saved files, and track or dimension readouts under
`.local/verify-evidence/<UTC timestamp>/`, which git ignores. They are for the person reviewing the
run.

A PR or issue gets only what holds no contact's media or identity: control screenshots checked
before upload, output dimensions, track counts, failure codes, and name-free filenames. Contact
names never go into the repo, a commit, a PR, or an issue.
