# 크레이브사가 번역기

크레이브 사가 게임 텍스트를 선택한 AI로 번역하는 비공식 Chrome 확장입니다.

## 주요 기능
- OpenAI · Gemini · Anthropic API 및 OpenAI 호환 서버
- ChatGPT 공식 로그인 연결(선택 설치한 Windows 로컬 helper 필요)
- 정확한 원문+대상 언어 캐시, 캐시 On/Off, 현재 화면 번역 직접 수정
- 대용량 캐시 입출력·병합과 배포용 번역 파일 수집

## 설치
1. [최신 릴리스](https://github.com/longtail7989/cravesaga-translator/releases/latest)에서 `*-extension.zip`을 받아 고정된 폴더에 압축을 풉니다.
2. `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램 로드**에서 해당 폴더를 선택합니다.
3. 확장 아이콘에서 제공자·모델·인증 정보와 전송 동의를 설정합니다. API 사용량·비용은 선택한 제공자 정책을 따릅니다.

업데이트는 같은 폴더에 파일을 교체하고 확장을 갱신하세요. 확장을 삭제하면 브라우저에 저장된 데이터가 지워질 수 있습니다. 실행 중인 게임은 진행 상황을 확인한 뒤 직접 새로고침하세요.

## ChatGPT helper
helper는 별도 저장소 [cravesage-translator-gpt-helper](https://github.com/longtail7989/cravesage-translator-gpt-helper)에서 독립적으로 관리·배포합니다. [helper 릴리스](https://github.com/longtail7989/cravesage-translator-gpt-helper/releases/latest)에서 받으세요. API 연결만 사용하면 설치할 필요가 없습니다. 이 저장소의 테스트·빌드·릴리스에는 helper 소스나 ZIP이 필요하지 않습니다.

helper는 Windows x64·Node.js 22.13 이상용 실험적 기능입니다. 현재 신뢰 대상은 개발용 확장 ID `mfoolamgailfmmpddefkpnbfiecleefi` 하나로 제한됩니다. 다른 경로·기기에서 압축해제한 확장은 ID가 달라질 수 있으므로 **일반적인 모든 압축해제 설치에서 ChatGPT 연결을 보장하지 않습니다.** 보안 검사를 우회하거나 허용 출처를 와일드카드로 바꾸지 마세요. [helper 설치·제약 안내](https://github.com/longtail7989/cravesage-translator-gpt-helper#readme)를 먼저 확인하세요. 저장소 분리 때문에 기존에 정상 연결한 사용자가 재설치·로그인할 필요는 없습니다.

helper에 포함된 OpenAI Sign-in with ChatGPT SDK는 **비상업용 라이선스**이며 별도 서비스 이용 조건이 적용됩니다. 로그인 자체가 모델 접근 권한·사용량 잔여를 보장하지 않습니다. helper 저장소에서 원본 라이선스와 제3자 고지를 확인하세요.

## 개발·배포
Node.js 22.13 이상을 사용합니다. 배포 자동화는 Windows·PowerShell 7에서 실행합니다.

```sh
node scripts/test.mjs
node scripts/build-extension.mjs --out dist
```

오프라인 회귀 검증은 확장 전용 22개 CJS suite(독립 실행 20개 + worker에 포함된 2개)를 실행하며, ChatGPT native-client 경계는 mock으로 검증합니다. 실제 로그인·제공자 요청이나 별도 helper 테스트는 실행하지 않습니다.

push·PR은 GitHub Actions 검증을 실행합니다. 향후 릴리스에서는 `manifest.json`과 `core.mjs`의 버전을 맞춘 뒤 `v0.3.5` 같은 태그를 push하면 검증 → 확장 ZIP 하나 생성 → 체크섬 → GitHub Release 게시를 진행합니다. 수동 실행도 지원합니다. 자세한 운영 순서는 [배포 안내](docs/RELEASING.md)를 참고하세요. **Chrome 웹 스토어 자동 게시 기능은 아닙니다.**

helper 저장소 분리는 확장 버전 변경이나 새 릴리스를 요구하지 않습니다. 기존 v0.3.5 확장 ZIP과 설치된 확장·인증 상태는 변경하지 않습니다.

## 데이터·권리
키·쿠키·로그인 토큰·개인 캐시·게임 계정 데이터는 저장소와 릴리스에 포함하지 않습니다. 번역 배포 파일에는 게임 대사와 사용자 이름이 포함될 수 있으니 공유 전에 확인하세요. 브라우저 할당량과 디스크 제한이 적용됩니다. 게임·캐릭터 이미지의 권리는 원저작권자에게 있으며 공식 제품이나 공식 제휴 도구가 아닙니다.
