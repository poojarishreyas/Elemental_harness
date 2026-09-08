# Package a Web backend plugin

English | [中文](publish.zh.md)

The [plugin configuration tutorial](./config.md) mounts a local plugin through a configuration patch. This reference explains how a package contributes a reusable configuration layer to the Web backend.

## Bundle manifest

A bundle is an npm package whose `package.json` declares the patch file under `dsh.bundle.patch`:

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

The patch file inserts plugin rows using names that resolve from the installed package:

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

A library without `dsh.bundle.patch` contributes no configuration layer. Its consumers import it as a dependency.

## Web profile configuration

The backend uses `$DSH_HOME/profiles/web`. Its `package.json` owns external dependencies and the ordered `dsh.profile.bundles` list. Installing a dependency alone does not add it to that list. Preserve the built-in base and Web application bundles when adding an external layer.

Deployment owners install external dependencies with their package manager, add bundle names to the profile manifest, and restart the backend after dependency changes. The backend has no plugin installation command. The [backend reference](../../../../apps/server/README.md) owns startup and configuration options.

## Layer order

The backend applies configuration in this order:

1. Bundles in the Web profile's manifest order.
2. The profile's `cordis.patch.yml`.
3. The Harness home's `cordis.patch.yml`.
4. Each `--patch` overlay in argument order.

A patch replaces a row's whole `config` value. Restate every required field when overriding a row. User patches can override a bundle's rows without editing its package.

## Distribution

Distribute built JavaScript and the declared patch file. TypeScript source packages need a build before the backend can load their JavaScript entry. Dependency installation scripts execute with the installer's permissions; deployment owners control which scripts their package manager allows.

## Next steps

- [Plugins and lifecycle](../framework/index.md)
- [Backend configuration](../../../../apps/server/README.md)
