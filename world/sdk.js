// Loads the Agora RTC and Signaling SDKs once each, in order: the Signaling bundle reads window.AgoraRTC as it loads.
const loading = new Map();
function script(src) {
  if (!loading.has(src)) loading.set(src, new Promise((resolve, reject) => {
    const element = document.createElement("script");
    element.src = src; element.async = true;
    element.onload = () => resolve();
    element.onerror = () => { loading.delete(src); element.remove(); reject(new Error("Could not load " + src + ".")); };
    document.head.append(element);
  }));
  return loading.get(src);
}
export async function loadAgora() {
  if (!window.AgoraRTC) await script("/assets/agora-rtc.js");
  if (!window.AgoraRTM) await script("/assets/agora-rtm.js");
  if (!window.AgoraRTC || !window.AgoraRTM) throw new Error("The Agora SDKs did not load.");
  return { AgoraRTC: window.AgoraRTC, AgoraRTM: window.AgoraRTM };
}
