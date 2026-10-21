import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectTest, detectTitle, humanizeTestName } from '../mapping/testName';

const lines = (s: string) => s.split('\n');

test('python: comment above decorated method inside a class', () => {
  const src = lines(['class TestLogin:', '    # kiwi: 12', '    @pytest.mark.smoke', '    def test_valid_user(self):', '        pass'].join('\n'));
  assert.deepEqual(detectTest(src, 1, '.py'), { testName: 'test_valid_user', testClass: 'TestLogin', definitionLine: 3 });
});

test('python: marker in docstring uses the enclosing function', () => {
  const src = lines(['def test_logout():', '    """kiwi: 3"""', '    do()'].join('\n'));
  assert.equal(detectTest(src, 1, '.py').testName, 'test_logout');
});

test('python: comment inside body does not jump to the next test', () => {
  const src = lines(['def test_a():', '    # kiwi: 1', '    x = 1', '', 'def test_b():', '    pass'].join('\n'));
  assert.equal(detectTest(src, 1, '.py').testName, 'test_a');
});

test('javascript: test name in it()/describe()', () => {
  const src = lines(["describe('Login', () => {", '  // kiwi: 4', "  it('accepts valid user', async () => {", '  });', '});'].join('\n'));
  assert.deepEqual(detectTest(src, 1, '.ts'), { testName: 'accepts valid user', testClass: 'Login', definitionLine: 2 });
});

test('java: annotation and method', () => {
  const src = lines(['public class LoginTest {', '    // kiwi: 9', '    @Test', '    public void validUser() throws Exception {', '        return foo(1);', '    }', '}'].join('\n'));
  assert.deepEqual(detectTest(src, 1, '.java'), { testName: 'validUser', testClass: 'LoginTest', definitionLine: 3 });
  // A statement inside the body must not be taken as a method.
  assert.equal(detectTest(src, 4, '.java').testName, 'validUser');
});

test('robot framework: tag line inside a test case', () => {
  const src = lines(['*** Test Cases ***', 'Valid Login', '    [Tags]    TC-5', '    Open Browser'].join('\n'));
  assert.deepEqual(detectTest(src, 2, '.robot'), { testName: 'Valid Login', definitionLine: 1 });
});

test('gherkin: tag above scenario', () => {
  const src = lines(['Feature: Login', '  @TC-7', '  Scenario: Valid user logs in', '    Given x'].join('\n'));
  assert.deepEqual(detectTest(src, 1, '.feature'), { testName: 'Valid user logs in', testClass: 'Login', definitionLine: 2 });
});

test('go and kotlin', () => {
  assert.equal(detectTest(lines('// kiwi: 1\nfunc TestLogin(t *testing.T) {'), 0, '.go').testName, 'TestLogin');
  assert.equal(detectTest(lines('// kiwi: 1\n@Test\nfun `user can log in`() {'), 0, '.kt').testName, 'user can log in');
});

test('humanizeTestName', () => {
  assert.equal(humanizeTestName('test_login_with_valid_user'), 'Login with valid user');
  assert.equal(humanizeTestName('testLoginWithValidUser'), 'Login with valid user');
  assert.equal(humanizeTestName(undefined), '');
});

test('pytest: tcms marker on a class (sphere e2e framework style)', () => {
  const src = lines(
    [
      '@allure.feature("Key Ceremony")',
      '@pytest.mark.e_admin',
      '@pytest.mark.tcms(case_id=37509)',
      'class TestKeyCeremonyFIPSFlow:',
      '',
      '    @allure.title("[E2E][e-admin][Key Ceremony] Key ceremony FIPS mode (Flow)")',
      '    @pytest.mark.order(1)',
      '    def test_fips_key_ceremony_password(self):',
      '        pass',
    ].join('\n'),
  );
  assert.deepEqual(detectTest(src, 2, '.py'), { testClass: 'TestKeyCeremonyFIPSFlow', definitionLine: 3 });
  // Cursor inside the method still resolves to the method.
  assert.deepEqual(detectTest(src, 8, '.py'), { testName: 'test_fips_key_ceremony_password', testClass: 'TestKeyCeremonyFIPSFlow', definitionLine: 7 });
});

test('detectTitle reads @allure.title above the definition', () => {
  const src = lines(['    @allure.title("[E2E][PKCS11] RSA key pair")', '    @allure.severity(allure.severity_level.CRITICAL)', '    def test_rsa(self):'].join('\n'));
  assert.equal(detectTitle(src, 2), '[E2E][PKCS11] RSA key pair');
  assert.equal(detectTitle(lines('x = 1\ndef test_a():'), 1), undefined);
});

test('humanizeTestName strips a Test class prefix', () => {
  assert.equal(humanizeTestName('TestKeyCeremonyFIPSFlow'), 'Key ceremony fipsflow');
});
