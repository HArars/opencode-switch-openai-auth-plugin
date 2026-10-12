import { AccountStore } from "../src/store"
import { credential } from "./auth-fixture"

const [directory, worker] = process.argv.slice(2)
if (!directory || !worker) throw new Error("Missing worker arguments")
const store = new AccountStore(directory, [])
for (let index = 0; index < 6; index++) {
  const user = `${worker}-${index}`
  await store.save(credential(`fake-${user}`, user))
}
