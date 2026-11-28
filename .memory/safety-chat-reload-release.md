# A chat-window reload must release its chats in main

Cmd+R reloads the chat page but keeps its webContents (same client id), and a page unload runs no
Preact unmount, so the old page's `chatRelease` never arrives. Main (`app/src/main.ts`) therefore
releases the client's chats on the chat window's `did-navigate`, as `closed` does — otherwise the
old mount keeps its thread pin and the new page's Home restore fails "that chat is already open".

- Hook `did-navigate` (a committed navigation), **not** `did-start-navigation`: a clicked http(s)
  link starts a navigation that `will-navigate` then cancels, and releasing there would orphan every
  chat on a page that stays up ("unknown chat session").
- e2e: `home-arrival.e2e.ts` "home: reopens after the chat window reloads".
