/**
 * 토스페이먼츠 결제 연동
 * 토스 개발자센터에서 클라이언트 키 발급 후 CLIENT_KEY 교체
 * 문서: https://docs.tosspayments.com
 */
window.PAYMENT = (function() {
  'use strict';
  var CLIENT_KEY = 'test_ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

  function getClientKey() {
    return typeof window.TOSS_CLIENT_KEY !== 'undefined' ? window.TOSS_CLIENT_KEY : CLIENT_KEY;
  }

  function runTossPayment(opts) {
    if (!window.TossPayments) {
      alert('토스페이먼츠 SDK를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.');
      return;
    }
    var payments = window.TossPayments(getClientKey());
    var request = {
      amount: opts.amount,
      orderId: opts.orderId,
      orderName: opts.orderName,
      successUrl: opts.successUrl,
      failUrl: opts.failUrl
    };
    if (opts.customerName) request.customerName = opts.customerName;
    payments.requestPayment('카드', request).catch(function(err) {
      console.error('TossPayments error', err);
      if (err.code) {
        location.href = opts.failUrl + '?code=' + encodeURIComponent(err.code) + '&message=' + encodeURIComponent(err.message || '결제 요청 실패');
      } else {
        alert('결제 요청 중 오류가 발생했습니다.');
      }
    });
  }

  return { runTossPayment: runTossPayment, getClientKey: getClientKey };
})();
