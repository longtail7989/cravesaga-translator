# 설치 및 사용 설명서

크레이브사가 번역기 확장 설치부터, 선택 사항인 ChatGPT helper 설치·공식 로그인·업데이트·문제 해결까지 설명합니다.

- 번역기 저장소: https://github.com/longtail7989/cravesaga-translator
- 번역기 다운로드: https://github.com/longtail7989/cravesaga-translator/releases/latest
- **별도 helper 저장소**: https://github.com/longtail7989/cravesage-translator-gpt-helper
- helper 다운로드: https://github.com/longtail7989/cravesage-translator-gpt-helper/releases/latest

확장 파일명 예시는 **v0.3.10**, 별도 helper 파일명 예시는 **v0.3.5** 기준입니다. 각각의 최신 릴리스에 있는 실제 버전·설명·파일명을 우선 확인하세요. 확장 업데이트가 helper의 버전 변경을 요구하지는 않습니다. 설치 설명을 게시하는 작업이 사용자 PC의 설치·로그인·게임 새로고침을 자동 실행하지는 않습니다.

## 목차

1. [먼저 확인할 사항과 설치 방식](#1-먼저-확인할-사항과-설치-방식)
2. [기존 사용자: 먼저 보존할 데이터](#2-기존-사용자-먼저-보존할-데이터)
3. [번역기 확장 설치](#3-번역기-확장-설치)
4. [방법 A: API 키로 연결하기](#4-방법-a-api-키로-연결하기)
5. [방법 B: ChatGPT helper로 연결하기](#5-방법-b-chatgpt-helper로-연결하기)
6. [게임에서 사용하기](#6-게임에서-사용하기)
7. [업데이트](#7-업데이트)
8. [문제 해결](#8-문제-해결)
9. [제거와 데이터 주의 사항](#9-제거와-데이터-주의-사항)
10. [설치 완료 점검표](#10-설치-완료-점검표)

## 1. 먼저 확인할 사항과 설치 방식

### 두 가지 연결 방식

- **API 키 방식**: OpenAI API, Google Gemini API, Claude·Anthropic API, OpenAI 호환 서버를 사용합니다. **helper가 필요 없습니다.** 제공자의 API 인증 정보·모델 이용 권한·API 과금 조건을 별도로 확인합니다.
- **ChatGPT 로그인 방식**: 확장과 함께 **Windows 로컬 helper를 추가 설치**하고, 공식 ChatGPT/OpenAI 페이지에서 직접 로그인·승인합니다. 확장 ZIP 안에는 helper가 들어 있지 않습니다.

ChatGPT 웹 구독과 OpenAI API 결제는 같은 것이 아닙니다. 구독이 있다고 API 키의 비용까지 포함되는 것은 아닙니다. 로그인 성공도 특정 모델 이용 자격·잔여 사용량·무제한 번역을 보장하지 않습니다.

### 현재 ChatGPT helper의 중요한 제한

> **helper를 설치하기 전에 반드시 확장 ID부터 확인하세요.**
>
> 현재 helper가 허용하는 확장 ID는 `mfoolamgailfmmpddefkpnbfiecleefi` 하나입니다. 압축해제한 확장의 ID는 설치 경로·브라우저 환경에 따라 달라질 수 있습니다. 다른 PC나 폴더에서 설치하면 이 ID와 다를 수 있으며, 그런 경우 현재 배포본의 ChatGPT 연결은 보장되지 않습니다.
>
> ID가 다르면 아래 helper 설치를 진행하지 말고 API 방식으로 사용하거나, 해당 ID를 정식으로 지원하는 배포를 기다리세요. ZIP을 다시 받거나 helper만 재설치한다고 해결되지 않습니다. ID를 임의로 속이거나 출처 검사·허용 목록을 와일드카드로 바꾸지 마세요.

- 확장은 `manifest.json` 기준 Chrome 116 이상을 요구합니다. 가급적 최신 Chrome을 사용하세요.
- helper 배포본은 **Windows x64 전용**입니다. Windows ARM64·32비트, macOS·Linux용 설치본이 아닙니다.
- helper 사용자는 **Node.js 22 LTS의 최신 보안 패치 버전(22.13 이상 권장)**과 PowerShell 7을 준비하세요. 현재 독립 CI는 Node 22 계열에서 검증합니다. Node는 helper ZIP에 포함되어 있지 않습니다.
- helper는 서명된 자동 설치 프로그램이나 자동 업데이트 서비스가 아닙니다.
- helper에 포함된 OpenAI SDK에는 **비상업용 라이선스**와 별도 서비스 이용 조건이 적용됩니다. helper 저장소의 라이선스·제3자 고지를 확인하세요.
- 비공식 도구입니다. 게임·캐릭터 이미지의 권리는 원저작권자에게 있습니다.

## 2. 기존 사용자: 먼저 보존할 데이터

이미 정상 작동하는 사용자는 저장소가 분리되었다는 이유만으로 확장이나 helper를 지우거나 다시 로그인할 필요가 없습니다.

1. 확장 팝업의 **캐시 → 캐시 파일 내보내기**로 필요한 번역을 비공개 파일에 백업합니다. 내보내기 완료 안내까지 팝업을 열어 두세요.
2. 사용하는 제공자·모델·확장 설치 폴더·helper 설치 폴더와 Node 경로를 확인합니다. 키나 토큰을 공개 이슈·스크린샷에 넣지 마세요.
3. 진행 중인 게임을 저장하거나 안전하게 중단할 수 있는 시점에 업데이트합니다.
4. 확장을 삭제하지 말고 기존의 고정 폴더를 유지하세요. 확장 제거·브라우저 데이터 삭제·프로필 변경은 설정과 캐시에 영향을 줄 수 있습니다.

캐시 파일은 **번역 데이터 백업**이지 로그인·API 키 백업이 아닙니다. 게임 원문·번역문·사용자 이름이 포함될 수 있으므로 공개 저장소에 올리지 마세요. helper의 `state`와 설치 백업도 공개하거나 다른 사람에게 전달하지 마세요.

## 3. 번역기 확장 설치

### 3-1. 확장 ZIP 받기

[번역기 Releases](https://github.com/longtail7989/cravesaga-translator/releases/latest)에서 다음 파일을 받습니다.

- `crave-ai-translator-0.3.10-extension.zip`
- 같은 릴리스의 `SHA256SUMS`

일반 설치에는 자동 생성된 **Source code (zip)**가 아니라 이름 끝이 **`-extension.zip`인 배포 파일**을 사용하세요.

다운로드가 손상되지 않았는지 PowerShell에서 확인할 수 있습니다. 실제 다운로드 파일명에 맞게 바꾸세요.

```powershell
$ExtensionZip = Join-Path $env:USERPROFILE 'Downloads\crave-ai-translator-0.3.10-extension.zip'
Get-FileHash -LiteralPath $ExtensionZip -Algorithm SHA256
Get-Content -LiteralPath (Join-Path $env:USERPROFILE 'Downloads\SHA256SUMS')
```

출력된 SHA-256을 해당 파일의 체크섬과 비교합니다. 다르면 중단하고 출처·파일을 확인하세요. 체크섬은 무결성 확인용이며 코드 서명이나 보안 보증을 대신하지 않습니다.

### 3-2. 고정 폴더에 압축 풀기

예를 들어 다음과 같이 설치 후 계속 유지할 폴더를 사용합니다.

```text
사용자 폴더\Apps\cravesaga-translator\
  manifest.json
  background.mjs
  popup.html
  icons\
  ...
```

**`manifest.json`이 직접 들어 있는 폴더**가 확장 루트입니다. 압축 프로그램이 폴더를 한 겹 더 만들었다면 안쪽 폴더를 선택해야 합니다. 임시 폴더나 자동 정리되는 위치는 피하세요.

### 3-3. Chrome에 등록하기

1. 사용할 Chrome 프로필에서 주소창에 `chrome://extensions`를 엽니다.
2. **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램 로드**를 누릅니다.
4. 위의 `manifest.json`이 들어 있는 폴더를 선택합니다.
5. **크레이브사가 번역기** 카드가 켜져 있는지 확인합니다.
6. Chrome 툴바의 확장 메뉴에서 아이콘을 고정하면 편리합니다.
7. 카드에 표시되는 **ID**를 확인합니다. helper를 사용할 때는 1절의 허용 ID와 정확히 같아야 합니다.

게임을 사용하는 프로필과 확장을 설치한 프로필이 같아야 합니다. 시크릿 모드·다른 Chromium 브라우저까지 동일하게 동작한다고 보장하지 않습니다.

확장을 설치한 뒤 이미 열려 있던 게임은 새 스크립트를 반영하려면 새로고침이 필요할 수 있습니다. **게임 진행 상황을 확인한 후 직접 새로고침하세요.**

## 4. 방법 A: API 키로 연결하기

helper 없이 사용할 수 있는 경로입니다. ChatGPT helper의 ID 조건을 충족하지 못할 때도 이 경로를 선택할 수 있습니다.

1. 게임 탭을 활성화하고 툴바의 번역기 아이콘을 누릅니다.
2. **연결 → 제공자**에서 `OpenAI API`, `Google Gemini API`, `Claude · Anthropic API`, `OpenAI 호환 서버` 중 하나를 고릅니다.
3. 제공자의 API 키와 사용할 **모델 ID**를 입력합니다. 직접 입력하거나 지원되는 경우 목록을 조회합니다.
4. 호환 서버는 해당 서버가 안내하는 주소·인증 방식·모델을 사용합니다. 주소에 키·사용자 정보·쿼리를 넣지 마세요. 원격 서버는 HTTPS가 필요하며 HTTP는 localhost 용도로만 허용됩니다.
5. 실제 번역을 켜기 전에 **선택한 제공자에 게임 텍스트 전송 동의** 내용을 읽습니다.
6. 원하는 자동 번역 상태를 선택하고 **변경 사항 저장**을 누릅니다. 입력만 하고 닫으면 저장되지 않습니다.
7. 서버 접근 권한 창이 나오면 대상 도메인을 확인한 뒤 승인합니다. 팝업이 닫혔다면 다시 열어 실제 저장 상태를 확인하세요.

**연결 테스트는 필수가 아닙니다.** 테스트 버튼은 실제 번역 요청을 보내 비용·사용량이 발생할 수 있습니다. 자동 번역을 켜는 경우에도 전송·과금 조건을 먼저 확인하세요.

인증 없이 기존 번역만 사용하려면 **캐시 전용 · AI 요청 안 함**을 선택할 수 있습니다. 캐시에 없는 문구는 원문으로 남습니다. API 설정만 사용한다면 5절은 건너뛰고 6절로 이동하세요.

## 5. 방법 B: ChatGPT helper로 연결하기

### 5-1. 시작 전 조건

다음 조건을 모두 확인한 뒤 진행합니다.

- Windows 설정의 시스템 종류가 **x64 기반 PC**입니다.
- 확장 ID가 `mfoolamgailfmmpddefkpnbfiecleefi`와 일치합니다.
- 공식 ChatGPT/OpenAI 로그인·권한 승인과 해당 계정의 이용 조건을 따를 수 있습니다.
- 일반 사용자 권한으로 설치할 수 있는 환경입니다. 관리자 권한으로 무작정 실행하지 않습니다.

helper는 로컬 HTTP 서버나 기존 Codex/Claude CLI 브리지가 아닙니다. **Codex CLI·Claude Code·Python·전역 npm 패키지를 설치할 필요가 없습니다.** 확장이 Chrome Native Messaging으로 필요할 때 실행합니다.

### 5-2. Node.js와 PowerShell 준비

Node.js는 [공식 Node.js 사이트](https://nodejs.org/)에서 Windows x64용으로 준비합니다. PowerShell은 [Microsoft PowerShell 설치 안내](https://learn.microsoft.com/powershell/scripting/install/install-powershell-on-windows)를 참고하세요.

PowerShell 7을 일반 사용자로 열고 확인합니다.

```powershell
$PSVersionTable.PSVersion
Get-Command node.exe | Select-Object Source
```

실제 `node.exe`의 고정 절대 경로를 선택합니다. 아래 경로는 공식 설치 프로그램의 일반적인 예시일 뿐이며, 자신의 설치 위치와 다르면 수정해야 합니다.

```powershell
$NodePath = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw '실제 node.exe의 고정 절대 경로로 NodePath를 바꾸세요.'
}
& $NodePath --version
& $NodePath -p "process.platform + '/' + process.arch"
```

버전과 함께 `win32/x64`인지 확인합니다. Windows ARM64 장치의 일반 지원을 뜻하는 검사는 아니므로 운영체제의 시스템 종류도 확인해야 합니다. 실행 파일 대신 `node`, `npm`, `.cmd` shim이나 CLI 이름을 지정하지 마세요. 설치 후 그 Node 파일을 이동·삭제하면 helper가 실행되지 않습니다.

### 5-3. helper 배포 ZIP 받기

[별도 helper Releases](https://github.com/longtail7989/cravesage-translator-gpt-helper/releases/latest)에서 받습니다.

- `cravesage-translator-gpt-helper-0.3.5-windows-x64.zip`
- 같은 릴리스의 **외부** `SHA256SUMS.txt`

일반 설치에는 **Source code (zip)** 대신 위의 **Windows x64 배포 ZIP**을 사용합니다. 소스 체크아웃에는 확장된 런타임 의존성이 없어서 그대로 설치하면 `Release payload missing` 오류가 날 수 있습니다.

```powershell
$HelperZip = Join-Path $env:USERPROFILE 'Downloads\cravesage-translator-gpt-helper-0.3.5-windows-x64.zip'
Get-FileHash -LiteralPath $HelperZip -Algorithm SHA256
Get-Content -LiteralPath (Join-Path $env:USERPROFILE 'Downloads\SHA256SUMS.txt')
```

해시를 비교한 뒤 다음 예시처럼 압축을 풉니다. 파일명·경로는 자신의 다운로드 위치에 맞추세요.

```powershell
$HelperSource = Join-Path $env:USERPROFILE 'Downloads\crave-helper-release-0.3.5'
Expand-Archive -LiteralPath $HelperZip -DestinationPath $HelperSource
Test-Path -LiteralPath (Join-Path $HelperSource 'host.cjs')
Test-Path -LiteralPath (Join-Path $HelperSource 'windows\install.ps1')
```

두 결과가 `True`여야 합니다. ZIP 루트에는 `host.cjs`, `windows`, `sdk`가 들어 있습니다. ZIP 내부 `SHA256SUMS.txt`는 개별 페이로드 파일 목록이며, Releases에서 별도로 받은 ZIP 체크섬 파일과 용도가 다릅니다.

이미 대상 폴더가 있다면 이전 파일과 섞지 말고 새 빈 폴더에 추출하세요. 배포 ZIP에는 의존성이 포함되어 있으므로 `npm install`을 실행할 필요가 없습니다.

### 5-4. 설치 경로 정하기

일반적인 기본 설치 경로는 다음과 같습니다.

```powershell
$HelperInstall = Join-Path $env:LOCALAPPDATA 'CraveAITranslator\chatgpt-helper'
```

- **압축을 푼 원본 폴더 `$HelperSource`와 실제 설치 폴더 `$HelperInstall`은 별개**여야 합니다. 서로 같거나 안에 중첩되면 설치가 거부됩니다.
- 기본 모드에서는 원본·설치 폴더가 현재 사용자 프로필 아래에 있어야 합니다.
- 현재 런처는 **설치 경로와 Node 경로가 ASCII 문자**여야 합니다. 공백은 검증된 경로에서 허용되지만, 한글 등 비 ASCII 문자 및 `% ! ^ & | < > "` 등의 위험 문자는 피해야 합니다.
- 사용자 소유 폴더여야 하며 링크·junction·reparse 경로, 다른 설치의 폴더나 레지스트리를 임의로 덮어쓰지 않습니다.

Windows 사용자 이름이 한글이어서 기본 설치 경로에 한글이 들어가면 [5-6절](#5-6-고급-기본-경로를-쓸-수-없는-경우)을 먼저 읽으세요. 경로 검사를 통과시키려고 보안 코드를 수정하지 마세요.

### 5-5. 미리 확인한 뒤 설치하기

먼저 **미리보기**를 실행합니다. 이 단계는 파일 배치·레지스트리 등록을 하지 않지만, Node 버전·경로·필수 페이로드 등의 사전 검사는 수행합니다.

```powershell
& (Join-Path $HelperSource 'windows\install.ps1') `
    -NodePath $NodePath `
    -InstallDir $HelperInstall `
    -WhatIf
```

오류가 없고 작업 대상이 맞는지 확인한 뒤, 실제 설치하려면 같은 명령에서 `-WhatIf`만 뺍니다.

```powershell
& (Join-Path $HelperSource 'windows\install.ps1') `
    -NodePath $NodePath `
    -InstallDir $HelperInstall
```

처음 설치인데 `Own installation exists`가 나오면 지우지 말고 7절의 업데이트 절차를 따르세요. `Native-host registry name collision`이면 다른 위치의 기존 등록이 있을 수 있습니다. 레지스트리를 삭제하거나 덮어써서 강제로 진행하지 마세요.

설치 스크립트가 하는 일:

- 허용된 런타임 파일을 사용자 소유 설치 폴더에 복사합니다.
- 사용자와 SYSTEM 중심의 접근 권한을 적용합니다.
- `launch-chatgpt.bat`와 Native Messaging manifest를 생성합니다.
- 현재 사용자의 HKCU에 자기 helper 등록을 추가합니다.
- 업데이트일 때 인정된 기존 설치·등록을 백업하고, 설치 실패 시 복구를 시도합니다.

**이 설치만으로 ChatGPT에 로그인하거나 번역을 요청하지 않습니다.** 시스템 전체 PATH 변경·전역 npm 설치·자동 시작 서비스 등록도 하지 않습니다.

서명·실행 정책·백신·회사 정책 때문에 차단되면 중단하고 정상적인 검토·허용 절차를 이용하세요. 실행 정책을 우회하거나 백신을 끄는 명령은 이 문서에서 제공하지 않습니다.

### 5-6. 고급: 기본 경로를 쓸 수 없는 경우

기본 사용자 경로에 한글이 있거나 다른 드라이브를 써야 한다면 설치기의 `-ApplicationRoot`를 사용할 수 있습니다. **현재 일반 사용자가 소유하는, 이미 존재하는 실제 ASCII 경로**가 필요합니다. 예를 들어 자신의 쓰기 가능한 드라이브에 마련한 `D:\CraveLocal`을 쓸 수 있지만, 그런 경로·드라이브가 모든 PC에 있다는 뜻은 아닙니다.

1. 현재 사용자에게 허용된 위치에 ASCII 이름의 폴더를 마련합니다. 권한이 없으면 중단하고 관리자의 정상 지원을 받으세요. 소유권을 강탈하거나 ACL을 약화시키지 않습니다.
2. **helper ZIP도 그 폴더 아래의 원본 하위 폴더에 다시 압축 해제**합니다.
3. 설치 대상은 원본과 겹치지 않는 별도 하위 폴더로 지정합니다.
4. 설치·업데이트·제거 시 같은 `-ApplicationRoot`를 계속 지정합니다.

아래는 위 조건을 만족하는 폴더를 이미 마련했을 때의 **예시**입니다.

```powershell
$AppRoot = 'D:\CraveLocal'
$HelperSource = Join-Path $AppRoot 'release-0.3.5'
$HelperInstall = Join-Path $AppRoot 'installed-helper'
Expand-Archive -LiteralPath $HelperZip -DestinationPath $HelperSource
& (Join-Path $HelperSource 'windows\install.ps1') `
    -NodePath $NodePath `
    -InstallDir $HelperInstall `
    -ApplicationRoot $AppRoot `
    -WhatIf
```

미리보기 결과를 확인한 후에만 `-WhatIf`를 빼서 설치합니다. Node 실행 파일 경로도 ASCII여야 합니다. 이 옵션은 관리자 권한·다른 사용자 소유 폴더·링크 경로를 허용하는 우회 옵션이 아닙니다.

### 5-7. 설치 결과를 읽기 전용으로 확인하기

설치 명령이 성공한 뒤 다음 파일이 생겼는지 확인합니다.

```powershell
Test-Path -LiteralPath (Join-Path $HelperInstall 'launch-chatgpt.bat')
Test-Path -LiteralPath (Join-Path $HelperInstall 'com.crave_ai_translator.chatgpt.json')
```

등록 위치를 확인하려면 다음 **조회 명령**을 사용할 수 있습니다.

```powershell
reg.exe query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.crave_ai_translator.chatgpt" /ve /reg:64
reg.exe query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.crave_ai_translator.chatgpt" /ve /reg:32
```

등록값은 실제 설치 폴더의 `com.crave_ai_translator.chatgpt.json`을 가리켜야 합니다. 파일만 생겼다고 브라우저 연결·로그인이 검증된 것은 아닙니다. 다른 브라우저 브랜드나 조직 정책의 Native Messaging 지원까지 보장하지 않습니다.

**`launch-chatgpt.bat`를 더블클릭하거나 `node host.cjs`를 직접 실행하지 마세요.** 일반 콘솔 프로그램이 아니라 Chrome이 필요한 원본·저장소 인수를 전달하는 stdio helper입니다. 토큰이 들어 있을 수 있는 `state` 파일은 열어 출력하거나 공유하지 않습니다.

### 5-8. 확장에서 공식 ChatGPT 로그인하기

1. 설치할 때와 같은 Windows 사용자·Chrome 프로필을 사용합니다.
2. 툴바의 번역기 팝업을 엽니다.
3. **연결 → 제공자 → ChatGPT 구독 · 로그인**을 선택합니다. 이 선택만으로 기존 제공자가 즉시 바뀌지는 않습니다.
4. **Continue with ChatGPT**를 누릅니다.
5. Native Messaging 사용 권한 요청이 나오면 대상 확장과 내용을 확인하고 승인합니다.
6. 로컬 helper가 여는 공식 OpenAI/ChatGPT 페이지에서 주소와 계정을 확인하고 로그인·요청된 권한 승인을 직접 완료합니다.
7. 확장으로 돌아와 **상태 확인**을 누릅니다. 계정 연결과 플랜 사용 권한이 확인되는지 봅니다.

확장 폼이나 이슈·채팅에 **ChatGPT 비밀번호·인증 코드·OAuth 토큰을 입력하지 마세요.** DMM 게임 로그인과 ChatGPT 로그인은 별개입니다.

로그인은 번역 테스트나 설정 저장을 자동 실행하지 않습니다. 팝업을 닫아도 로그인 절차는 계속될 수 있으므로 상태부터 확인하고 중복으로 로그인 버튼을 누르지 마세요. 팝업의 계정 추가·로그아웃은 실제 계정 연결 상태를 바꾸므로 명시적으로 필요할 때만 사용하세요.

권한 승인 직후에도 helper를 찾지 못하면 무작정 재설치하지 말고 8절의 확장 권한·브라우저 재연결 순서를 확인하세요.

### 5-9. 모델·전송 동의·자동 번역 저장

1. **모델 목록 조회**를 누르고 사용할 모델 ID를 선택하거나 입력합니다.
2. 모델 목록은 이용 자격·잔여량을 보장하지 않습니다. 계정·플랜·모델별 이용 조건을 확인합니다.
3. 실제 AI 번역을 사용할 때 **캐시 전용 · AI 요청 안 함**이 켜져 있지 않은지 확인합니다.
4. **선택한 제공자에 게임 텍스트 전송 동의**를 읽고 동의하는 경우에만 체크합니다.
5. **자동 번역**을 원하는 상태로 선택하고 **변경 사항 저장**을 누릅니다.
6. 저장 결과를 확인합니다. 로그인만 완료하거나 모델만 선택하고 닫으면 번역 제공자 설정이 저장되지 않을 수 있습니다.

**구독 사용량 사용 · 연결 테스트**는 선택 사항입니다. 누르면 실제 번역 요청을 보내 사용량·한도가 소모될 수 있습니다. 단순히 설치 성공 여부를 확인하려고 자동 실행할 필요가 없습니다.

## 6. 게임에서 사용하기

1. 평소 사용하는 정상 경로로 크레이브 사가 게임을 엽니다.
2. 게임 탭이 활성화된 상태에서 번역기 툴바 아이콘을 엽니다. 상태의 **게임 연결됨**을 확인합니다.
3. 이미 실행 중이던 게임에 확장을 새로 설치·갱신했다면 진행 상황을 확인한 뒤 게임을 직접 새로고침합니다.
4. 게임이 준비된 뒤 화면 문구·스토리를 확인합니다. 추출 가능한 게임 텍스트가 대상이며 이미지 속 글자까지 모두 번역하는 OCR 도구는 아닙니다.

### 캐시와 직접 수정

- **캐시 On**: 정확한 원문과 대상 언어가 같으면 저장 번역을 재사용합니다. 제공자·모델·화면·문맥이 달라도 재사용할 수 있습니다.
- **캐시 Off**: 캐시 재사용 없이 새 번역을 시도하고 성공한 결과로 캐시를 갱신합니다. 추가 비용·사용량이 발생하며 **기존 수동 수정본도 바뀔 수 있습니다.**
- **캐시 전용**: AI 요청 없이 저장 번역만 적용합니다. 캐시 Off보다 우선하며 없는 문구는 원문으로 남습니다.
- **수정**: 현재 화면의 번역을 골라 원문과 함께 확인하고 저장합니다. AI 요청 없이 표시·캐시를 수정하며 숫자·태그·변수·줄바꿈 검증을 통과해야 합니다.
- **실패 문구 다시 시도**: 수동 재시도 역시 추가 요청·비용·사용량을 발생시킬 수 있습니다.

저장량은 브라우저 할당량과 디스크 여유 공간의 제한을 받습니다. 일일 한도·재시도 설정은 설치자의 필요에 맞춰 확인하세요. 0으로 설정된 한도가 비용이나 저장 용량이 무한하다는 뜻은 아닙니다.

### 배포용 번역 수집

게임 리모콘의 **배포 Start / Finish**는 개인 캐시와 별도의 기록을 수집해 선택한 NDJSON 파일로 저장하는 기능입니다. 시작할 때 파일 위치를 선택하고, 종료·저장 완료 안내까지 확인하세요. 수집 자체가 별도 AI 번역 요청을 추가하는 것은 아니지만 게임의 일반 번역 요청은 계속 발생할 수 있습니다.

게임을 새로고침하면 진행 중인 배포 기록을 자동으로 마감·저장하고 **배포 Start** 대기로 돌아갑니다. 이미 허용된 파일 권한으로 저장할 수 있으면 Finish를 따로 누르지 않습니다. 권한 재확인·파일 오류가 있으면 저장 창을 유지하므로 안내를 확인하세요. 이전 수집을 자동 재개하거나 새 수집을 자동 시작하지 않습니다.

파일에 게임 원문·번역·사용자 이름이 포함될 수 있으니 공유 전에 확인하세요. 계정 토큰·helper 상태 폴더를 번역 배포 파일에 섞지 않습니다.

### 대사 자동진행 · 선택

v0.3.10의 리모콘에서 **대사 자동진행 Off**를 눌러 켭니다. 기본 Off이고 배포 Start와 독립적입니다. 캐시 대사도 한국어를 게임의 진행률에 맞춰 서서히 표시하며, 원래 게임과 한국어 표시·번역·진행 중인 배포 수집 저장이 모두 끝나야 캔버스 중앙을 한 번 클릭합니다. 선택지·백로그·메뉴에서는 기다리고 수정창에서는 일시정지합니다. 배포 기록 오류·Finish·설정 변경·탭 숨김·페이지 이동 시 꺼집니다. 실제 게임 화면 구조를 확인할 수 없거나 번역이 없으면 건너뛰지 않습니다.


## 7. 업데이트

### 7-1. 확장 업데이트

1. 필요한 캐시를 먼저 내보냅니다.
2. 게임을 안전하게 중단할 수 있는 시점을 잡습니다.
3. 새 `-extension.zip`의 체크섬을 확인합니다.
4. **기존과 같은 확장 폴더**에 새 배포 파일을 교체합니다. 새 경로로 옮기거나 확장을 제거하지 않습니다.
5. `chrome://extensions`에서 해당 확장의 **새로고침**을 누릅니다.
6. 제공자·모델·동의·캐시 상태를 확인합니다.
7. 게임 진행 상황을 확인한 뒤 직접 게임을 새로고침합니다.

확장을 갱신하면 실행 중 게임의 이전 연결이 끊길 수 있습니다. 그 자체가 캐시 삭제를 뜻하지는 않습니다. 문제 해결 목적으로 확장 제거·전체 데이터 삭제부터 하지 마세요.

v0.3.10은 팝업과 백그라운드의 버전·기능이 다르면 작업을 잠그고 **확장 다시 로드**를 안내합니다. 배포 기록도 복구 API 버전을 확인하므로 이전 워커가 남으면 **확장 업데이트 필요**를 표시합니다. 같은 폴더의 파일을 바꾸기만 해서는 실행 중인 워커가 교체되지 않을 수 있습니다. 다시 로드 후 팝업을 다시 열어 **0.3.10**을 확인하고 게임도 새로고침하세요. 이 동작은 저장된 캐시·설정을 초기화하지 않습니다. 이 업데이트를 이유로 helper를 재설치하거나 확장 ID 허용 정책을 바꾸지 않습니다.

### 7-2. helper 업데이트

helper와 확장은 별도 저장소에서 독립 배포됩니다. 저장소 분리만으로 기존 helper를 재설치할 필요는 없습니다.

업데이트가 필요한 경우:

1. 기존 **helper 설치 경로와 고정 Node 경로**를 확인합니다.
2. 진행 중인 게임·작업을 안전하게 마친 뒤 helper를 사용하는 브라우저·확장 창을 닫아 helper가 종료되게 합니다. 사용 중인 상태를 덮어쓰지 않습니다.
3. 새 helper ZIP을 **설치 폴더 밖의 새 원본 폴더**에 추출합니다.
4. 원래 설치 경로를 그대로 지정하고 `-Upgrade`를 붙여 미리 봅니다.

```powershell
& (Join-Path $HelperSource 'windows\install.ps1') `
    -NodePath $NodePath `
    -InstallDir $HelperInstall `
    -Upgrade `
    -WhatIf
```

대상·백업 안내를 확인한 뒤에만 `-WhatIf`를 빼서 실제 업데이트합니다. 사용자 지정 ApplicationRoot 설치였다면 동일한 `-ApplicationRoot $AppRoot`도 붙여야 합니다.

기존 자기 설치의 `state`는 백업에서 유지하도록 구현되어 있지만, **같은 Windows 사용자·기존 설치 경로를 유지하는 정상 업데이트를 전제로 합니다.** 다른 PC·Windows 계정에 복사하면 DPAPI 보호 상태를 그대로 사용할 수 있다고 보장하지 않습니다. 잠금·소유권·등록 충돌 오류가 나면 중단하세요. 잠금 파일을 임의 삭제하거나 모든 Node 프로세스를 강제 종료하지 마세요.

업데이트 후 브라우저를 다시 열어 **상태 확인**부터 합니다. 기존 연결이 유효하면 재로그인할 필요가 없습니다. 백업에는 보호된 계정 데이터가 있을 수 있으므로 공개하지 마세요.

## 8. 문제 해결

### 확장 로드 실패 / manifest를 찾을 수 없음

- ZIP 파일 자체나 바깥 폴더가 아니라 `manifest.json`이 직접 들어 있는 폴더를 선택했는지 확인합니다.
- Source code ZIP 대신 `-extension.zip`을 받았는지 확인합니다.
- 확장 카드의 오류를 읽되 키·쿠키·토큰이 포함된 전체 로그를 공개하지 않습니다.

### 확장 ID가 다름 / 허용되지 않는 출처

- `chrome://extensions`의 ID를 확인합니다.
- 현재 허용 ID와 다르면 helper 재설치·로그인 반복을 멈춥니다.
- API 방식으로 사용하거나 정식 지원 배포를 기다립니다. manifest와 host의 허용 목록을 임의로 완화하지 않습니다.

### helper 없음 / Native host를 찾을 수 없음

다음 순서대로 확인하세요.

1. 확장 ID와 Windows x64 조건을 확인합니다.
2. helper ZIP이 아니라 **설치 스크립트까지 실제 실행**했는지 확인합니다. 압축 해제만으로 등록되지 않습니다.
3. 설치 시 지정한 Node 실행 파일과 helper 설치 폴더가 아직 있는지 확인합니다.
4. 5-7절의 파일·HKCU 등록값이 같은 설치 경로를 가리키는지 조회합니다.
5. 툴바의 **Continue with ChatGPT**에서 Native Messaging 권한을 허용했는지 확인합니다.
6. 권한 컨텍스트가 오래된 경우 확장 카드의 새로고침 후 팝업을 다시 열어 봅니다. 게임은 안전한 시점에 직접 새로고침합니다.
7. 필요하면 작업을 저장한 뒤 브라우저를 완전히 종료·재시작합니다.

기존 등록이 정상인데도 연결이 안 되면 재설치부터 반복하지 마세요. 브라우저 브랜드·조직 정책·실행 정책·등록 충돌을 확인해야 할 수 있습니다. Chromium 전용 등록이 Chrome 등록을 가리는 경우도 있으므로 임의의 레지스트리 삭제로 해결하지 않습니다.

### 설치가 경로·권한·정책 오류로 중단됨

- 원본과 대상이 겹치지 않는지, 현재 사용자 소유 범위인지 확인합니다.
- 설치 경로·Node 경로에 한글이나 위험 문자가 없는지 확인합니다.
- 심볼릭 링크·junction 폴더가 아닌지 확인합니다.
- 한글 사용자 프로필이면 5-6절의 정상적인 사용자 소유 ASCII 경로 절차를 검토합니다.
- `Release payload missing`이면 Source code ZIP이 아니라 준비된 helper 배포 ZIP을 새 빈 폴더에 추출합니다.
- 회사 정책·서명·실행 정책·백신 경고를 우회하거나 보안 기능을 끄지 않습니다.

### 로그인은 됐지만 모델 조회·번역이 안 됨

- 같은 계정의 연결과 플랜 사용 권한이 확인되는지 봅니다.
- 모델 ID·계정 이용 자격·한도·전송 동의·자동 번역·저장 상태를 확인합니다.
- 캐시 전용 모드에서는 새 AI 번역을 하지 않습니다.
- 로그인과 설정 저장은 별개입니다. **변경 사항 저장**을 완료했는지 확인합니다.
- 제공자 제한·사용량 초과·영구 인증 오류는 반복 테스트로 해결되지 않을 수 있습니다. 무제한 사용을 기대하거나 계정을 순환해 제한을 우회하지 마세요.

### 현재 탭에서 게임을 찾지 못함

- GitHub나 일반 웹페이지가 아니라 **게임 탭을 활성화한 상태에서 툴바 팝업**을 엽니다.
- 다른 Chrome 프로필인지, 게임 클라이언트 사이트 접근 권한이 허용되어 있는지 확인합니다.
- 게임 로딩 완료를 기다립니다. 확장 갱신 후에는 게임의 오래된 연결을 새로 반영해야 할 수 있습니다.
- 이미지 글자나 추출되지 않는 텍스트는 이 번역기의 대상이 아닐 수 있습니다.

### 로그인 상태·DPAPI·저장소 오류

- 같은 Windows 사용자 계정에서 실행 중인지 확인합니다.
- 다른 PC·계정에서 복사한 `state`를 덮어쓰지 않습니다.
- 보호를 끄거나 평문 토큰 저장으로 바꾸지 않습니다.
- 정상 종료 후에도 잠금 오류가 계속되면 민감 정보를 제외한 오류 코드·버전·OS·확장 ID 등으로 지원을 요청합니다. 임의의 잠금 삭제·소유권 변경·전체 상태 초기화부터 하지 마세요.

## 9. 제거와 데이터 주의 사항

### helper 등록만 제거

게임·브라우저 작업을 안전하게 마치고 helper를 종료한 뒤, **자신이 실제로 설치한 폴더**를 지정합니다.

```powershell
& (Join-Path $HelperInstall 'windows\uninstall.ps1') `
    -InstallDir $HelperInstall `
    -WhatIf
```

결과를 확인한 뒤에만 `-WhatIf`를 빼서 등록을 제거합니다. 사용자 지정 설치였다면 `-ApplicationRoot $AppRoot`도 지정하세요.

기본 제거는 자기 HKCU 등록을 지우지만 **helper 파일·보호된 상태는 남깁니다.** `-RemoveFiles`를 명시하면 자기 설치를 백업한 다음 파일을 제거합니다. 백업은 자동 삭제되지 않으며, 보호된 계정 정보가 포함될 수 있습니다. 등록 제거가 제공자 측 로그인 권한의 해제와 같은 것은 아닙니다.

### 확장 제거

Chrome 확장 제거는 설정·캐시 손실을 일으킬 수 있으므로 먼저 필요한 번역을 내보내고 진행합니다. 확장 제거와 helper 등록 제거는 별개입니다. 브라우저 프로필·게임 계정·DMM 로그인 데이터를 정리할 필요는 없습니다.

## 10. 설치 완료 점검표

### 공통

- [ ] 올바른 배포 ZIP과 체크섬을 확인했다.
- [ ] 고정 폴더에서 확장을 로드했고 게임과 같은 Chrome 프로필을 사용한다.
- [ ] 사용할 제공자·모델·전송 동의·비용 조건을 확인했다.
- [ ] 변경 사항을 실제로 저장했다.
- [ ] 게임 탭에서 연결 상태를 확인했다.
- [ ] 진행 상황을 확인한 후 필요한 게임 새로고침을 직접 했다.

### ChatGPT helper 사용자 추가 항목

- [ ] 현재 허용 확장 ID와 일치한다. 다르면 설치를 중단했다.
- [ ] Windows x64와 실제 Node 실행 파일·버전을 확인했다.
- [ ] helper를 별도 저장소의 배포 ZIP으로 받고 체크섬을 비교했다.
- [ ] 원본과 설치 폴더를 분리하고 설치 미리보기 후 실제 등록했다.
- [ ] Native Messaging 권한과 공식 로그인·플랜 사용 권한을 확인했다.
- [ ] 모델을 선택하고 제공자 설정을 저장했다.
- [ ] 연결 테스트가 실제 사용량을 소모할 수 있음을 이해했다.
- [ ] 키·토큰·`state`·설치 백업·개인 캐시를 공개하지 않았다.

자세한 구현·보안 조건은 [helper README](https://github.com/longtail7989/cravesage-translator-gpt-helper#readme), [Windows 설치 구현 안내](https://github.com/longtail7989/cravesage-translator-gpt-helper/blob/main/windows/README.md), 번역 데이터 형식은 [CACHE.md](CACHE.md)를 참고하세요.
