# vendor

`agent-device-proxy-0.21.27-dev-54e4e4d.tgz` is `@agent-device/proxy`, packed
from the `simlock-integration` branch of agent-device at commit
`54e4e4db971d75ba1ebeb75c0ab7bce45c7d9b28`:

```bash
pnpm --filter @agent-device/proxy pack --pack-destination <dir>
```

Its `prepack` runs the package's own build, which bundles agent-device's
internal packages into `dist`, so the tarball has no `workspace:` dependency.
It is swapped for the npm release later.
