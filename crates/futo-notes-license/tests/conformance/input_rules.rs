//! Constants, purchase surface, key grammar, input shape and deep-link vectors.
use super::*;

#[test]
fn constants_match_the_fixture() {
    let fixture = fixture();
    let constants = &fixture["constants"];

    assert_eq!(PRODUCT_SLUG, text(constants, "productSlug"));
    // A separate constant on purpose: what an activation payload calls the
    // product and what the storefront calls it are different strings, and the
    // fixture carries both so neither can be tidied into the other.
    assert_eq!(
        CHECKOUT_PRODUCT_SLUG,
        text(constants, "checkoutProductSlug")
    );
    assert_ne!(PRODUCT_SLUG, CHECKOUT_PRODUCT_SLUG);
    assert_eq!(DEEP_LINK_SCHEME, text(constants, "deepLinkScheme"));
    assert_eq!(KEY_ALPHABET, text(constants, "keyAlphabet"));
    assert_eq!(SUPPORT_MAILTO, text(constants, "supportMailto"));
    assert_eq!(APP_STORE_PRODUCT_ID, text(constants, "appStoreProductId"));

    assert_eq!(ORG_SLUG, text(constants, "orgSlug"));

    // The Buy destination is environment-split like the key and the activation
    // host (M3): a `.dev` build must reach staging checkout, never production.
    let buy = &constants["buyUrls"];
    for (name, environment) in [
        ("production", Environment::Production),
        ("staging", Environment::Staging),
    ] {
        let expected = &buy[name];
        let config = environment.config();
        assert_eq!(
            buy_url(config, Platform::Desktop, BuySource::LicenseCard),
            text(expected, "desktop"),
            "{name} desktop buy URL"
        );
        assert_eq!(
            buy_url(config, Platform::Ios, BuySource::LicenseCard),
            text(expected, "ios"),
            "{name} iOS buy URL"
        );
        assert_eq!(
            buy_url(config, Platform::Android, BuySource::LicenseCard),
            text(expected, "android"),
            "{name} Android buy URL"
        );
    }

    // What a NameWebsite build shows as plain text, split the same way.
    let website = &constants["websiteAddress"];
    assert_eq!(
        Environment::Production.website_address(),
        text(website, "production")
    );
    assert_eq!(
        Environment::Staging.website_address(),
        text(website, "staging")
    );

    let environments = &constants["environments"];
    // The dev/prod split is data here, not a compile flag, so a shell cannot
    // land a `.dev` build on the production key (M3).
    for (name, environment) in [
        ("production", Environment::Production),
        ("staging", Environment::Staging),
    ] {
        for bundle_id in environments[name]["bundleIds"]
            .as_array()
            .expect("bundleIds array")
        {
            let bundle_id = bundle_id.as_str().expect("bundle id");
            assert_eq!(
                Environment::from_bundle_suffix(bundle_id),
                environment,
                "{bundle_id} must resolve to the {name} environment"
            );
        }
    }
    assert_eq!(
        Environment::Production.config().pay2_base_url,
        text(&environments["production"], "pay2BaseUrl")
    );
    assert_eq!(
        Environment::Staging.config().pay2_base_url,
        text(&environments["staging"], "pay2BaseUrl")
    );
    // Every environment must carry a parseable key, or a dev build would fail
    // in a way no test covers.
    for environment in [Environment::Production, Environment::Staging] {
        let pair = LicensePair {
            key: "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78".into(),
            activation: "v2.cGF5bG9hZA.c2lnbmF0dXJl".into(),
        };
        assert_eq!(
            evaluate(&pair, environment.config(), instant("2026-09-09T12:00:00Z")),
            LicenseState::Invalid(InvalidReason::SignatureMismatch),
            "{environment:?} public key must parse — a key that cannot be read \
             would report every license as malformed instead"
        );
    }
}

/// What each distribution may do about buying. `linkOut` is the same rule
/// asked as a yes/no (the iOS shell still asks that way), so both tables are
/// held here.
#[test]
fn purchase_surface_vectors() {
    let fixture = fixture();
    let cases = fixture["purchaseSurface"]
        .as_array()
        .expect("purchaseSurface");
    let mut failures = Vec::new();
    for case in cases {
        let distribution = match text(case, "distribution") {
            "desktop" => Distribution::Desktop,
            "iosAppStore" => Distribution::IosAppStore,
            "androidDirect" => Distribution::AndroidDirect,
            "androidPlay" => Distribution::AndroidPlay,
            other => panic!("unknown distribution {other}"),
        };
        let expected = match text(case, "expected") {
            "linkOut" => PurchaseSurface::LinkOut,
            "nameWebsite" => PurchaseSurface::NameWebsite,
            "keyOnly" => PurchaseSurface::KeyOnly,
            other => panic!("unknown surface {other}"),
        };
        let actual = license_purchase_surface(distribution, case["storefrontCountry"].as_str());
        if actual != expected {
            failures.push(format!(
                "{}: {actual:?} != {expected:?}",
                text(case, "name")
            ));
        }
    }
    for case in fixture["linkOut"].as_array().expect("linkOut") {
        let platform = match text(case, "platform") {
            "ios" => Platform::Ios,
            "android" => Platform::Android,
            _ => Platform::Desktop,
        };
        let actual = license_link_out(
            platform,
            case["storefrontCountry"].as_str(),
            case["buildAllows"].as_bool().expect("buildAllows"),
        );
        if Some(actual) != case["expected"].as_bool() {
            failures.push(format!("linkOut {}: {actual}", text(case, "name")));
        }
    }
    report("purchase surface", failures, cases.len());
}

/// What the iOS App Store-only purchase changes (ADR-0009): the plate and
/// what the device includes, for every pair of facts it can hold.
#[test]
fn app_store_evidence_vectors() {
    let fixture = fixture();
    let cases: Vec<&Value> = fixture["appStoreEvidence"]
        .as_array()
        .expect("appStoreEvidence")
        .iter()
        .filter(|case| case.get("name").is_some())
        .collect();
    let mut failures = Vec::new();
    for case in &cases {
        let evidence = LicenseEvidence {
            key: match text(case, "key") {
                "unlicensed" => LicenseStatus::Unlicensed,
                "licensed" => LicenseStatus::Licensed,
                "expired" => LicenseStatus::Expired,
                other => panic!("unknown key status {other}"),
            },
            app_store: case["appStore"].as_bool().expect("appStore"),
        };
        let expected = &case["expected"];
        let plate = match text(expected, "plate") {
            "unlicensed" => LicensePlate::Unlicensed,
            "licensed" => LicensePlate::Licensed,
            "appStore" => LicensePlate::AppStore,
            "expired" => LicensePlate::Expired,
            other => panic!("unknown plate {other}"),
        };
        let includes: Vec<LicenseInclusion> = expected["includes"]
            .as_array()
            .expect("includes")
            .iter()
            .map(|name| match name.as_str() {
                Some("appIcon") => LicenseInclusion::AppIcon,
                other => panic!("unknown inclusion {other:?}"),
            })
            .collect();
        if license_plate(evidence) != plate || evidence_includes(evidence) != includes {
            failures.push(format!(
                "{}: {:?} {:?}",
                text(case, "name"),
                license_plate(evidence),
                evidence_includes(evidence)
            ));
        }
    }
    report("App Store evidence", failures, cases.len());
}

#[test]
fn license_key_grammar() {
    let fixture = fixture();
    let cases = fixture["licenseKey"].as_array().expect("licenseKey array");
    let mut failures = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let input = text(case, "input");
        let normalized = normalize_license_key(input);
        if normalized != text(case, "normalized") {
            failures.push(format!(
                "  {name}: normalize({input:?}) = {normalized:?}, expected {:?}",
                text(case, "normalized")
            ));
        }
        let valid = is_valid_license_key(input);
        let expected = case["valid"].as_bool().expect("valid bool");
        if valid != expected {
            failures.push(format!(
                "  {name}: is_valid_license_key({input:?}) = {valid}, expected {expected}"
            ));
        }
    }
    report("licenseKey", failures, cases.len());
}

#[test]
fn input_shape_recognition() {
    let fixture = fixture();
    let cases = fixture["recognizeInput"]
        .as_array()
        .expect("recognizeInput array");
    let mut failures = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let input = text(case, "input");
        let actual = recognize_input(input);
        let expected = &case["expected"];
        let matches = match (&actual, expected) {
            (None, Value::Null) => true,
            (Some(LicenseInput::BareKey(key)), Value::Object(_)) => {
                expected["shape"] == "bareKey" && expected["key"] == key.as_str()
            }
            (Some(LicenseInput::Pair(pair)), Value::Object(_)) => {
                expected["shape"] == "pair"
                    && expected["key"] == pair.key.as_str()
                    && expected["activation"] == pair.activation.as_str()
            }
            _ => false,
        };
        if !matches {
            failures.push(format!(
                "  {name}: recognize_input({input:?}) = {actual:?}, expected {expected}"
            ));
        }
    }
    report("recognizeInput", failures, cases.len());
}

#[test]
fn deep_link_parsing() {
    let fixture = fixture();
    let cases = fixture["deepLink"].as_array().expect("deepLink array");
    let mut failures = Vec::new();
    for case in cases {
        let name = text(case, "name");
        let input = text(case, "input");
        let actual = parse_deep_link(input);
        let expected = &case["expected"];
        let matches = match (&actual, expected) {
            (None, Value::Null) => true,
            (Some(pair), Value::Object(_)) => {
                expected["key"] == pair.key.as_str()
                    && expected["activation"] == pair.activation.as_str()
            }
            _ => false,
        };
        if !matches {
            failures.push(format!(
                "  {name}: parse_deep_link({input:?}) = {actual:?}, expected {expected}"
            ));
        }
    }
    report("deepLink", failures, cases.len());
}
