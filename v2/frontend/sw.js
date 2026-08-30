// 앱 설치(홈 화면 추가)만 가능하게 하는 최소 서비스워커.
// 일부러 아무것도 캐시하지 않는다 - 캐시를 쓰면 업데이트가 반영 안 되고
// 예전 버전이 계속 보이는 문제가 생기기 쉽다. 항상 네트워크로 최신 버전을 받는다.
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
