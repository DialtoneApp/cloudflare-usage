# cloudflare-usage
Check Cloudflare D1, R2, Workers usage – see remaining limits for today/month

# run
CLOUDFLARE_API_TOKEN=replace-with-token node main.js 

# get-token
[https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)

# scopes
make an API token with `Account Analytics:Read` and `Account Settings:Read` 
scoped to one Cloudflare account.

# web-version
[https://dialtoneapp.com/cloudflare](https://dialtoneapp.com/cloudflare)

# sample-run

```
Daily reset in 23h 55m 24s
Monthly reset in 4d 23h 55m 24s

5 resources with analytics
2026-04-01 through 2026-04-26 UTC

D1 databases (1 found)
  57f868ec-3197-483e-bca3-367263fd9bba
    Today read: 2 / 5,000,000 (4,999,998 left - 0.00%)
    Today written: 0 / 100,000 (100,000 left - 0.00%)
    Month read: 216,917,419 / 25,000,000,000 (24,783,082,581 left - 0.87%)
    Month written: 2,143,469 / 50,000,000 (47,856,531 left - 4.29%)
    Storage: 477.0 MB / 5.0 GB (4.5 GB left - 9.32%)

R2 buckets (2 found)
  account
    Today Class A: 0
    Month Class A: 70 / 1,000,000 (999,930 left - 0.01%)
    Today Class B: 0
    Month Class B: 0 / 10,000,000 (10,000,000 left - 0.00%)
    Storage: 0 B / 10.0 GB (10.0 GB left - 0.00%)
    Objects: 0
  dialtone-production
    Today Class A: 0
    Month Class A: 99,920 / 1,000,000 (900,080 left - 9.99%)
    Today Class B: 0
    Month Class B: 41,260 / 10,000,000 (9,958,740 left - 0.41%)
    Storage: 768.7 MB / 10.0 GB (9.2 GB left - 7.51%)
    Objects: 25,010

Workers (1 found)
  super-river-a6f2
    Today requests: 9 / 100,000 (99,991 left - 0.01%)
    Month requests: 387,738 / 10,000,000 (9,612,262 left - 3.88%)
    Today errors: 0
    Month errors: 67
    CPU time: 788,885 ms

Queues (1 found)
  4dbe05529f80445c9adb8e84037fcf63
    Today ops: 0 / 10,000 (10,000 left - 0.00%)
    Month ops: 10,895 / 1,000,000 (989,105 left - 1.09%)
    Today bytes: 0 B
    Month bytes: 1.5 MB
```
