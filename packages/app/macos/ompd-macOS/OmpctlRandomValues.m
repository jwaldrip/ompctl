/**
 * `crypto.getRandomValues`, for macOS.
 *
 * `packages/app/index.js` installs the global from
 * `react-native-get-random-values` before anything can generate a key, because
 * Hermes ships no `crypto` and the tunnel's sealed handshake needs a CSPRNG.
 * That package's 2.x native side is a pure TurboModule: `RNGetRandomValues.mm`
 * carries no `RCT_EXPORT_MODULE`, only a codegen spec conformance and a
 * `getTurboModule`. This target runs the old architecture
 * (`RCT_NEW_ARCH_ENABLED = 0` in the Podfile, because Fabric has no AppKit
 * views here), where module discovery is `RCT_EXPORT_MODULE` and nothing else,
 * so on macOS that class compiled into the binary and registered nothing. The
 * first socket the app opened died with
 * "'RNGetRandomValues' could not be found. Verify that a module by this name is
 * registered in the native binary", and every reconnect after it died the same
 * way: the Mac app could never reach a daemon.
 *
 * So the host provides the module under the name the package's JavaScript
 * looks up. The package's own pod still builds into this target, and that is
 * fine precisely because of the defect above: its class claims no module name
 * under this architecture, so this one is the only thing registered as
 * `RNGetRandomValues`. That balance is what pins this file to
 * `RCTNewArchEnabled = false` in `macos/ompd-macOS/Info.plist`, which
 * `scripts/check-platform-manifests.ts` already asserts: flip the
 * architecture and the TurboModule wakes up, at which point this file comes
 * out rather than registering a second implementation beside it.
 *
 * `arc4random_buf` rather than `SecRandomCopyBytes`: both draw on the same
 * kernel entropy, but Security.framework reaches this target only through
 * another pod's link flags (react-native-keychain's podspec), and a CSPRNG
 * that stops linking when an unrelated dependency changes is not one worth
 * having. `arc4random_buf` is in libSystem, is what Swift's own
 * `SystemRandomNumberGenerator` calls on Darwin, and cannot fail, so there is
 * no error branch here to get wrong.
 */

#import <React/RCTBridgeModule.h>
#import <stdlib.h>

@interface OmpctlRandomValues : NSObject <RCTBridgeModule>
@end

@implementation OmpctlRandomValues

RCT_EXPORT_MODULE(RNGetRandomValues)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

// Synchronous by contract: the package's `getRandomValues` fills the caller's
// typed array from this return value on the JavaScript thread, and WebCrypto's
// signature gives it nowhere to await. The 65536-byte WebCrypto quota is the
// caller's to enforce and the package's JavaScript already does, so a length
// this side cannot honour raises rather than answering with a shorter string
// that would read as randomness.
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getRandomBase64:(double)byteLength)
{
  NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)byteLength];
  arc4random_buf(data.mutableBytes, data.length);
  return [data base64EncodedStringWithOptions:0];
}

@end
