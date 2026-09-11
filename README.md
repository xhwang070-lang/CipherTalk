# Huaji

Private local WeChat archive for Huabo.

English product name: **Huaji**. Company: **Huabo**.

This app is a localized fork of [CipherTalk](https://github.com/ILoveBingLu/miyu) (CC BY-NC-SA 4.0). Keep original credit on About.

## Develop

```
npm install
npm run electron:dev
```

## Package

```
npm run check:wcdb-dll
npm run build:win
```

The installer uses appId `com.huabo.huaji` and installs to a Huaji directory. It will not overwrite the official CipherTalk install.

Do not commit keys, `all_keys.json`, or decrypted databases.
