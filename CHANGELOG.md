# Changelog

## [2.0.1](https://github.com/zytact/GramGrab/compare/v2.0.0...v2.0.1) (2026-10-06)


### Bug Fixes

* **watch:** make Story Watches work again for accounts without active Stories ([#240](https://github.com/zytact/GramGrab/issues/240)) ([4d945e2](https://github.com/zytact/GramGrab/commit/4d945e2208aa447f3d56fa8257edca204237b625))
* **watch:** stop the person's own 429s from pausing all Watches ([#241](https://github.com/zytact/GramGrab/issues/241)) ([6eef1a0](https://github.com/zytact/GramGrab/commit/6eef1a0128105d8e574010674752b7161d29d572))

## [2.0.0](https://github.com/zytact/GramGrab/compare/v1.1.0...v2.0.0) (2026-10-06)


### ⚠ BREAKING CHANGES

* **cli:** the extension, CLI, and native host now speak protocol version 2 and reject other versions with PROTOCOL_VERSION_UNSUPPORTED. Update all three together.

### Features

* **cli:** manage Watches from the terminal over protocol version 2 ([#224](https://github.com/zytact/GramGrab/issues/224)) ([7ea45a8](https://github.com/zytact/GramGrab/commit/7ea45a8ed04b2a433be4bce50ab8a9f0bc0bd697))
* **cli:** mention a newer release once a day ([#180](https://github.com/zytact/GramGrab/issues/180)) ([f5d1bef](https://github.com/zytact/GramGrab/commit/f5d1bef4f0d894f6db19ae64360189da9e91af9f))
* **watch:** check Stories and collect discoveries into the Watch inbox ([#225](https://github.com/zytact/GramGrab/issues/225)) ([a73b5d9](https://github.com/zytact/GramGrab/commit/a73b5d953a905e566275aa986327127f200a9054))
* **watch:** discover Avatar changes by picture identity ([#229](https://github.com/zytact/GramGrab/issues/229)) ([b21e053](https://github.com/zytact/GramGrab/commit/b21e0534885f8d9ee2c77614a056d15a0d944c07))
* **watch:** discover Instants from the shared feed ([#228](https://github.com/zytact/GramGrab/issues/228)) ([4c63345](https://github.com/zytact/GramGrab/commit/4c6334511e2ce642db3e47e61d63ec04b4829396))
* **watch:** discover Posts, Reels, and Sidecars across paced pages ([#227](https://github.com/zytact/GramGrab/issues/227)) ([319d99e](https://github.com/zytact/GramGrab/commit/319d99e396e5eff316bf9bcece29054861d6a2b8))
* **watch:** download originals and recover individual actions ([#233](https://github.com/zytact/GramGrab/issues/233)) ([2e6a0de](https://github.com/zytact/GramGrab/commit/2e6a0de9dc4590916275be7b12c462396b3e5a3d))
* **watch:** export exact Watch inbox media as Original ([#232](https://github.com/zytact/GramGrab/issues/232)) ([4b1ca27](https://github.com/zytact/GramGrab/commit/4b1ca27900013235a438beb4862045a7193fc90b))
* **watch:** export inbox media with frozen processing choices ([#234](https://github.com/zytact/GramGrab/issues/234)) ([97a31d8](https://github.com/zytact/GramGrab/commit/97a31d8ed99cdd8907ea8cae415ae05654b38eca))
* **watch:** manage attention and inbox through the CLI ([#236](https://github.com/zytact/GramGrab/issues/236)) ([38f4e18](https://github.com/zytact/GramGrab/commit/38f4e18e59335b7d7a76ec430036678036668f74))
* **watch:** manage owner-bound Watches from a Beta options page ([#223](https://github.com/zytact/GramGrab/issues/223)) ([a53ddc8](https://github.com/zytact/GramGrab/commit/a53ddc86272c66df1128ca1ac0359c2cfaae138e))
* **watch:** notify about Watch discoveries and failures ([#230](https://github.com/zytact/GramGrab/issues/230)) ([36ed181](https://github.com/zytact/GramGrab/commit/36ed181d02d588629cbe31b28dddad84a94a9c58))
* **watch:** run durable checks through the CLI ([#235](https://github.com/zytact/GramGrab/issues/235)) ([0e00b4b](https://github.com/zytact/GramGrab/commit/0e00b4b7bd73b2b351f3da34b3ac2d87a931ec06))
* **watch:** schedule paced Watch rounds and recover them after restarts ([#226](https://github.com/zytact/GramGrab/issues/226)) ([f8ab41e](https://github.com/zytact/GramGrab/commit/f8ab41ead17e9973b5cb37031836ad832a6b9ea3))


### Bug Fixes

* **instagram:** resolve posts from private accounts ([#203](https://github.com/zytact/GramGrab/issues/203)) ([71be3f8](https://github.com/zytact/GramGrab/commit/71be3f82c08437eb5131291a56f790809e2b7280))

## [1.1.0](https://github.com/zytact/GramGrab/compare/v1.0.1...v1.1.0) (2026-09-30)


### Features

* **cli:** install and update the CLI with one command ([#175](https://github.com/zytact/GramGrab/issues/175)) ([3bbfad4](https://github.com/zytact/GramGrab/commit/3bbfad4ed5974e56dca23039ee5611f98c7a672e))
* **extension:** update installed releases from GitHub releases ([#174](https://github.com/zytact/GramGrab/issues/174)) ([417ec0f](https://github.com/zytact/GramGrab/commit/417ec0fcdbdb9265005b6900ea7d6c77c44c00c1))
